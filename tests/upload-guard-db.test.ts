/**
 * Focused tests for the direct-upload-vs-checkout guard
 * (`app/lib/upload-guard-db.ts`, P3C-2 Codex HIGH follow-up).
 *
 * Like `checkout-db.test.ts` / `checkin-db.test.ts`, the fake database's
 * `$transaction` + `$queryRaw` ("... FOR UPDATE") simulation uses a REAL
 * per-row async mutex (acquired on the CadDocument lock query, released only
 * when the transaction's callback settles), so the checkout-vs-direct-upload
 * race test below genuinely exercises blocking + post-unblock
 * re-evaluation - the same shared lock `checkout-db.ts` takes. A REAL
 * PostgreSQL race is also proven separately in the live integration gate;
 * per the task's own instruction, a fake DB race alone is not the
 * authoritative proof.
 *
 * Storage is the REAL `LocalFilesystemStorage` against a temp directory,
 * since this module reuses `uploadCadFileVersion` verbatim.
 *
 * Run with:  node --experimental-strip-types --test tests/upload-guard-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import { LocalFilesystemStorage } from "../app/lib/storage-core.ts";
import {
  ActiveCheckoutBlocksUploadError,
  CadDocumentNotFoundError,
  ReservedCopyDesignTargetError,
  UploadConcurrencyConflictError,
  storeCadFileVersionForActor,
  type UploadGuardDb,
} from "../app/lib/upload-guard-db.ts";
import {
  requestCheckoutForActor,
  type CheckoutDb,
} from "../app/lib/checkout-db.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-upload-guard-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function textSource(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

// ------------------------------------------------------------
// Shared in-memory fake database (used both as UploadGuardDb and as
// CheckoutDb, so the cross-module race test below exercises BOTH real
// modules against the SAME state, exactly like the live PostgreSQL gate
// exercises both real routes against the same real database).
// ------------------------------------------------------------

class RowLock {
  #tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.#tail;
    this.#tail = prior.then(() => mine);
    await prior;
    return release;
  }
}

class FakeUniqueConstraintError extends Error {
  readonly code = "P2002";
  constructor() {
    super("Unique constraint failed on the (cadDocumentId, versionNumber) fields");
  }
}

interface DocRow {
  organizationId: string;
  id: string;
  fileName: string;
}
interface VersionRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
  originalFileName: string;
  storageKey: string;
  fileSize: bigint;
  checksum: string;
  createdById: string;
}
interface UserRow {
  organizationId: string;
  id: string;
  name: string;
  email: string;
}
interface CheckoutRow {
  organizationId: string;
  id: string;
  cadDocumentId: string;
  baseFileVersionId: string;
  checkedOutById: string;
}

interface LineageRow {
  organizationId: string;
  newCadDocumentId: string;
}

class FakeDatabase {
  readonly docs: DocRow[] = [];
  readonly versions: VersionRow[] = [];
  readonly users: UserRow[] = [];
  readonly checkouts: CheckoutRow[] = [];
  readonly events: Array<Record<string, unknown>> = [];
  // P6C Round 2, HIGH 1: empty by default for every existing test in this
  // file (none of them are Copy Design reserved targets) - populated only by
  // the new reserved-target tests below.
  readonly lineages: LineageRow[] = [];
  readonly #locks = new Map<string, RowLock>();
  transactionAttempts = 0;

  addDoc(organizationId: string, id: string, fileName = "part.ipt"): this {
    this.docs.push({ organizationId, id, fileName });
    return this;
  }
  addUser(organizationId: string, id: string, name: string, email: string): this {
    this.users.push({ organizationId, id, name, email });
    return this;
  }
  addVersion(row: Omit<VersionRow, "fileSize"> & { fileSize: number }): this {
    this.versions.push({ ...row, fileSize: BigInt(row.fileSize) });
    return this;
  }
  addCheckout(row: CheckoutRow): this {
    this.checkouts.push(row);
    return this;
  }
  addLineage(organizationId: string, newCadDocumentId: string): this {
    this.lineages.push({ organizationId, newCadDocumentId });
    return this;
  }

  #lockFor(key: string): RowLock {
    let lock = this.#locks.get(key);
    if (!lock) {
      lock = new RowLock();
      this.#locks.set(key, lock);
    }
    return lock;
  }

  #latestVersion(organizationId: string, cadDocumentId: string): VersionRow | null {
    const rows = this.versions
      .filter((v) => v.organizationId === organizationId && v.cadDocumentId === cadDocumentId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return rows[0] ?? null;
  }

  #hydrateCheckout(row: CheckoutRow) {
    const version = this.versions.find((v) => v.id === row.baseFileVersionId);
    const user = this.users.find((u) => u.id === row.checkedOutById);
    return {
      id: row.id,
      cadDocumentId: row.cadDocumentId,
      baseFileVersionId: row.baseFileVersionId,
      checkedOutById: row.checkedOutById,
      checkedOutAt: new Date(),
      note: null,
      baseFileVersion: { versionNumber: version?.versionNumber ?? 0 },
      checkedOutBy: { name: user?.name ?? "", email: user?.email ?? "" },
    };
  }

  #createCheckout(data: {
    organizationId: string;
    cadDocumentId: string;
    baseFileVersionId: string;
    checkedOutById: string;
  }) {
    const conflict = this.checkouts.some(
      (c) => c.organizationId === data.organizationId && c.cadDocumentId === data.cadDocumentId,
    );
    if (conflict) {
      throw new FakeUniqueConstraintError();
    }
    const row: CheckoutRow = {
      organizationId: data.organizationId,
      id: `co-${randomBytes(6).toString("hex")}`,
      cadDocumentId: data.cadDocumentId,
      baseFileVersionId: data.baseFileVersionId,
      checkedOutById: data.checkedOutById,
    };
    this.checkouts.push(row);
    return this.#hydrateCheckout(row);
  }

  #createVersion(data: {
    organizationId: string;
    cadDocumentId: string;
    createdById: string;
    versionNumber: number;
    originalFileName: string;
    storageKey: string;
    fileSize: bigint;
    checksum: string;
  }) {
    const conflict = this.versions.some(
      (v) => v.cadDocumentId === data.cadDocumentId && v.versionNumber === data.versionNumber,
    );
    if (conflict) {
      throw new FakeUniqueConstraintError();
    }
    const row: VersionRow = {
      organizationId: data.organizationId,
      cadDocumentId: data.cadDocumentId,
      id: `fv-${randomBytes(6).toString("hex")}`,
      versionNumber: data.versionNumber,
      originalFileName: data.originalFileName,
      storageKey: data.storageKey,
      fileSize: data.fileSize,
      checksum: data.checksum,
      createdById: data.createdById,
    };
    this.versions.push(row);
    return { id: row.id, versionNumber: row.versionNumber };
  }

  #makeTx(self: FakeDatabase) {
    return {
      $queryRaw: (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const cadDocumentId = values[0] as string;
        const organizationId = values[1] as string;
        const row = self.docs.find((d) => d.id === cadDocumentId && d.organizationId === organizationId);
        if (!row) return [];
        return [{ id: row.id, organizationId: row.organizationId }];
      }) as unknown,
      fileVersion: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          const latest = self.#latestVersion(args.where.organizationId, args.where.cadDocumentId);
          return latest ? { id: latest.id, versionNumber: latest.versionNumber } : null;
        }) as unknown,
        findMany: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          return self.versions
            .filter((v) => v.organizationId === args.where.organizationId && v.cadDocumentId === args.where.cadDocumentId)
            .sort((a, b) => b.versionNumber - a.versionNumber)
            .map((v) => ({
              id: v.id,
              versionNumber: v.versionNumber,
              checksum: v.checksum,
              fileSize: Number(v.fileSize),
              storageKey: v.storageKey,
            }));
        }) as unknown,
        create: (async (args: {
          data: {
            organizationId: string;
            cadDocumentId: string;
            createdById: string;
            versionNumber: number;
            originalFileName: string;
            storageKey: string;
            fileSize: bigint;
            checksum: string;
          };
        }) => {
          return self.#createVersion(args.data);
        }) as unknown,
      },
      cadCheckout: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          const row = self.checkouts.find(
            (c) => c.organizationId === args.where.organizationId && c.cadDocumentId === args.where.cadDocumentId,
          );
          return row ? self.#hydrateCheckout(row) : null;
        }) as unknown,
        create: (async (args: {
          data: { organizationId: string; cadDocumentId: string; baseFileVersionId: string; checkedOutById: string };
        }) => {
          return self.#createCheckout(args.data);
        }) as unknown,
      },
      cadCheckoutEvent: {
        create: (async (args: { data: Record<string, unknown> }) => {
          self.events.push({ ...args.data });
          return { id: `ev-${randomBytes(6).toString("hex")}` };
        }) as unknown,
      },
      cadCopyLineage: {
        findFirst: (async (args: { where: { organizationId: string; newCadDocumentId: string } }) => {
          const row = self.lineages.find(
            (l) => l.organizationId === args.where.organizationId && l.newCadDocumentId === args.where.newCadDocumentId,
          );
          return row ? { id: `lin-${row.newCadDocumentId}` } : null;
        }) as unknown,
      },
    };
  }

  get asUploadGuardDb(): UploadGuardDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
          return self.docs.find((d) => d.id === args.where.id && d.organizationId === args.where.organizationId) ?? null;
        }) as unknown as UploadGuardDb["cadDocument"]["findFirst"],
      },
      fileVersion: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          const latest = self.#latestVersion(args.where.organizationId, args.where.cadDocumentId);
          return latest ? { id: latest.id, versionNumber: latest.versionNumber } : null;
        }) as unknown as UploadGuardDb["fileVersion"]["findFirst"],
      } as unknown as UploadGuardDb["fileVersion"],
      cadCheckout: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          const row = self.checkouts.find(
            (c) => c.organizationId === args.where.organizationId && c.cadDocumentId === args.where.cadDocumentId,
          );
          return row ? self.#hydrateCheckout(row) : null;
        }) as unknown as UploadGuardDb["cadCheckout"]["findFirst"],
      } as unknown as UploadGuardDb["cadCheckout"],
      cadCopyLineage: {
        findFirst: (async (args: { where: { organizationId: string; newCadDocumentId: string } }) => {
          const row = self.lineages.find(
            (l) => l.organizationId === args.where.organizationId && l.newCadDocumentId === args.where.newCadDocumentId,
          );
          return row ? { id: `lin-${row.newCadDocumentId}` } : null;
        }) as unknown as UploadGuardDb["cadCopyLineage"]["findFirst"],
      } as unknown as UploadGuardDb["cadCopyLineage"],
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
        self.transactionAttempts += 1;
        const releases: Array<() => void> = [];
        const tx = self.#makeTx(self);
        // Wrap $queryRaw to also acquire the shared per-document lock.
        const lockedQueryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const cadDocumentId = values[0] as string;
          const organizationId = values[1] as string;
          const lockKey = `${organizationId}:${cadDocumentId}`;
          const release = await self.#lockFor(lockKey).acquire();
          releases.push(release);
          return (tx.$queryRaw as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
        }) as unknown;
        try {
          return await fn({ ...tx, $queryRaw: lockedQueryRaw });
        } finally {
          for (const release of releases) release();
        }
      }) as unknown as UploadGuardDb["$transaction"],
    } as unknown as UploadGuardDb;
  }

  get asCheckoutDb(): CheckoutDb {
    return this.asUploadGuardDb as unknown as CheckoutDb;
  }
}

class FakeProvider {
  readonly root = new Map<string, boolean>();
  async exists(key: string): Promise<boolean> {
    return this.root.get(key) ?? false;
  }
}

function actorIn(organizationId: string, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role: UserRole.ENGINEER,
    name: "Test User",
    email: `user@${organizationId}.example`,
    ...overrides,
  };
}

async function seedDocumentWithV1(
  db: FakeDatabase,
  storage: LocalFilesystemStorage,
  organizationId = "orgA",
  docId = "doc-1",
): Promise<{ v1Id: string }> {
  db.addUser(organizationId, `user-${organizationId}`, "Owner", `owner@${organizationId}.example`);
  db.addDoc(organizationId, docId);
  const storageKey = `org/${organizationId}/doc/${docId}/v1/seed0001`;
  await storage.put(storageKey, Buffer.from("v1 original bytes"));
  const v1Id = `fv-${docId}-1`;
  db.addVersion({
    organizationId,
    cadDocumentId: docId,
    id: v1Id,
    versionNumber: 1,
    originalFileName: "part.ipt",
    storageKey,
    fileSize: 18,
    checksum: "seed-checksum",
    createdById: `user-${organizationId}`,
  });
  return { v1Id };
}

// ------------------------------------------------------------
// A. No checkout -> direct upload allowed (bootstrap preserved)
// ------------------------------------------------------------

test("no checkout: direct bootstrap upload succeeds and creates the next FileVersion", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedDocumentWithV1(db, storage);
    const actor = actorIn("orgA");

    const result = await storeCadFileVersionForActor(
      actor,
      "doc-1",
      textSource("v2 bytes"),
      "part-v2.ipt",
      10_000,
      db.asUploadGuardDb,
      storage,
    );

    assert.equal(result.versionNumber, 2);
    assert.equal(db.versions.length, 2);
  });
});

test("a brand-new document with zero versions still allows the very first (bootstrap) upload", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addUser("orgA", "user-orgA", "Owner", "owner@orgA.example");
    db.addDoc("orgA", "doc-new");
    const actor = actorIn("orgA");

    const result = await storeCadFileVersionForActor(
      actor,
      "doc-new",
      textSource("v1 bytes"),
      "first.ipt",
      10_000,
      db.asUploadGuardDb,
      storage,
    );
    assert.equal(result.versionNumber, 1);
  });
});

// ------------------------------------------------------------
// B. Active checkout -> direct upload rejected, even for the owner
// ------------------------------------------------------------

test("checkout exists: direct upload returns a controlled conflict (ActiveCheckoutBlocksUploadError), no new FileVersion", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedDocumentWithV1(db, storage);
    db.addCheckout({
      organizationId: "orgA",
      id: "co-1",
      cadDocumentId: "doc-1",
      baseFileVersionId: v1Id,
      checkedOutById: "user-orgA",
    });
    const other = actorIn("orgA", { userId: "user-other" });
    db.addUser("orgA", "user-other", "Other", "other@orgA.example");

    await assert.rejects(
      () =>
        storeCadFileVersionForActor(other, "doc-1", textSource("x"), null, 10_000, db.asUploadGuardDb, storage),
      ActiveCheckoutBlocksUploadError,
    );
    assert.equal(db.versions.length, 1, "no new FileVersion created");
    assert.equal(db.checkouts.length, 1, "checkout unchanged");
  });
});

test("checkout owner also cannot direct-upload while their own checkout is active", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedDocumentWithV1(db, storage);
    db.addCheckout({
      organizationId: "orgA",
      id: "co-1",
      cadDocumentId: "doc-1",
      baseFileVersionId: v1Id,
      checkedOutById: "user-orgA",
    });
    const owner = actorIn("orgA");

    await assert.rejects(
      () =>
        storeCadFileVersionForActor(owner, "doc-1", textSource("x"), null, 10_000, db.asUploadGuardDb, storage),
      ActiveCheckoutBlocksUploadError,
      "even the checkout's OWN owner must use Check-In, not direct upload",
    );
    assert.equal(db.versions.length, 1);
    assert.equal(db.checkouts.length, 1);
  });
});

test("a different (non-owner, non-checkout-holder) writable actor also cannot direct-upload while a checkout is active", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedDocumentWithV1(db, storage);
    db.addUser("orgA", "user-holder", "Holder", "holder@orgA.example");
    db.addCheckout({
      organizationId: "orgA",
      id: "co-1",
      cadDocumentId: "doc-1",
      baseFileVersionId: v1Id,
      checkedOutById: "user-holder",
    });
    db.addUser("orgA", "user-third", "Third", "third@orgA.example");
    const third = actorIn("orgA", { userId: "user-third" });

    await assert.rejects(
      () =>
        storeCadFileVersionForActor(third, "doc-1", textSource("x"), null, 10_000, db.asUploadGuardDb, storage),
      ActiveCheckoutBlocksUploadError,
    );
    assert.equal(db.versions.length, 1);
  });
});

test("cross-tenant document remains hidden (404) for direct upload, never leaked", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedDocumentWithV1(db, storage, "orgB", "doc-secret");
    const outsider = actorIn("orgA");

    await assert.rejects(
      () =>
        storeCadFileVersionForActor(outsider, "doc-secret", textSource("x"), null, 10_000, db.asUploadGuardDb, storage),
      CadDocumentNotFoundError,
    );
  });
});

// ------------------------------------------------------------
// C. Concurrency: direct-upload vs checkout-acquisition race
// ------------------------------------------------------------

test("direct-upload vs checkout-acquisition race: the two never both win in a way that silently bypasses exclusive checkout semantics", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedDocumentWithV1(db, storage);
    const actor = actorIn("orgA");

    const [checkoutResult, uploadResult] = await Promise.allSettled([
      requestCheckoutForActor(actor, "doc-1", db.asCheckoutDb, {
        exists: (key: string) => storage.exists(key),
      } as never),
      storeCadFileVersionForActor(actor, "doc-1", textSource("racing v2"), null, 10_000, db.asUploadGuardDb, storage),
    ]);

    const checkoutOk = checkoutResult.status === "fulfilled";
    const uploadOk = uploadResult.status === "fulfilled";

    if (checkoutOk && uploadOk) {
      // Checkout won the lock first: its base MUST be v1 (upload was
      // blocked until the checkout committed, then rejected).
      assert.equal(db.versions.length, 1, "upload must have been rejected if checkout also succeeded");
    } else if (uploadOk && !checkoutOk) {
      // Upload won the lock first: checkout must have failed (no checkout
      // exists) OR re-resolved against the NEW v2 as its base - never v1.
      assert.equal(db.versions.length, 2);
      if (db.checkouts.length === 1) {
        assert.equal(
          db.checkouts[0]!.baseFileVersionId,
          db.versions.find((v) => v.versionNumber === 2)!.id,
          "a checkout that succeeds after a direct upload committed must be based on the NEW version, never a stale v1",
        );
      }
    } else if (checkoutOk && !uploadOk) {
      assert.equal(db.versions.length, 1, "checkout won; upload must not have created a version");
      assert.equal(db.checkouts[0]!.baseFileVersionId, "fv-doc-1-1");
    } else {
      assert.fail("at least one of checkout or direct upload must succeed");
    }

    // Never both a NEW checkout based on the OLD version AND a new version -
    // that would be the silently-bypassed-exclusivity state this test exists
    // to rule out.
    if (db.checkouts.length === 1 && db.versions.length === 2) {
      assert.notEqual(
        db.checkouts[0]!.baseFileVersionId,
        "fv-doc-1-1",
        "checkout must not be based on v1 while v2 already exists",
      );
    }
  });
});

test("many-way concurrent race between direct uploads and a checkout attempt never leaves an inconsistent state", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedDocumentWithV1(db, storage);
    const actor = actorIn("orgA");

    const results = await Promise.allSettled([
      storeCadFileVersionForActor(actor, "doc-1", textSource("a"), null, 10_000, db.asUploadGuardDb, storage),
      storeCadFileVersionForActor(actor, "doc-1", textSource("b"), null, 10_000, db.asUploadGuardDb, storage),
      requestCheckoutForActor(actor, "doc-1", db.asCheckoutDb, {
        exists: (key: string) => storage.exists(key),
      } as never),
    ]);

    const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
    assert.ok(fulfilledCount >= 1, "at least one operation must succeed");

    if (db.checkouts.length === 1) {
      const latest = db.versions.reduce((a, b) => (a.versionNumber > b.versionNumber ? a : b));
      assert.equal(
        db.checkouts[0]!.baseFileVersionId,
        latest.id,
        "whenever a checkout exists, it must be based on the document's actual current version",
      );
    }
  });
});

// ------------------------------------------------------------
// P6C Round 2, HIGH 1: generic upload must not bypass P6C materialization
// authority for a P6B-reserved Copy Design target.
// ------------------------------------------------------------

test("an ORDINARY zero-version CadDocument (no lineage) can still use generic bootstrap upload", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addDoc("orgA", "doc-ordinary");
    const actor = actorIn("orgA");

    const result = await storeCadFileVersionForActor(actor, "doc-ordinary", textSource("hello"), null, 10_000, db.asUploadGuardDb, storage);

    assert.equal(result.versionNumber, 1);
    assert.equal(db.versions.length, 1);
  });
});

test("a P6B-reserved zero-version Copy Design target CANNOT use generic upload for its first version", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addDoc("orgA", "doc-reserved");
    db.addLineage("orgA", "doc-reserved");
    const actor = actorIn("orgA");

    await assert.rejects(
      () => storeCadFileVersionForActor(actor, "doc-reserved", textSource("hello"), null, 10_000, db.asUploadGuardDb, storage),
      (err: unknown) => err instanceof ReservedCopyDesignTargetError,
    );
    // no FileVersion is created on rejection
    assert.equal(db.versions.length, 0);
  });
});

test("a cross-tenant reserved target is hidden as a normal 404, never leaking the reservation guard", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addDoc("orgA", "doc-reserved");
    db.addLineage("orgA", "doc-reserved");
    const actor = actorIn("orgB");

    await assert.rejects(
      () => storeCadFileVersionForActor(actor, "doc-reserved", textSource("hello"), null, 10_000, db.asUploadGuardDb, storage),
      (err: unknown) => err instanceof CadDocumentNotFoundError,
    );
  });
});

test("after a valid materialization creates FileVersion 1, normal subsequent generic-upload version behavior resumes (no active checkout)", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addDoc("orgA", "doc-reserved");
    db.addLineage("orgA", "doc-reserved");
    // Simulate P6C having already materialized FileVersion 1 (by whatever
    // path - this test does not care how, only that the guard is gone once
    // >= 1 FileVersion exists).
    const storageKey = "org/orgA/doc/doc-reserved/v1/materialized0001";
    await storage.put(storageKey, Buffer.from("materialized v1 bytes"));
    db.addVersion({
      organizationId: "orgA", cadDocumentId: "doc-reserved", id: "fv-materialized-1", versionNumber: 1,
      originalFileName: "materialized.ipt", storageKey, fileSize: 22, checksum: "irrelevant", createdById: "someone",
    });
    const actor = actorIn("orgA");

    const result = await storeCadFileVersionForActor(actor, "doc-reserved", textSource("v2 content"), null, 10_000, db.asUploadGuardDb, storage);

    assert.equal(result.versionNumber, 2);
    assert.equal(db.versions.length, 2);
  });
});

test("concurrent generic upload cannot race P6C first materialization and bypass the guard - whichever locks first, only ONE version 1 (via materialize) ever exists and generic upload never wins the reserved race", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addDoc("orgA", "doc-reserved");
    db.addLineage("orgA", "doc-reserved");
    const actor = actorIn("orgA");

    // Two CONCURRENT generic-upload attempts against the SAME reserved,
    // zero-version target - simulates a generic upload racing an in-flight
    // P6C materialization attempt for the same document (P6C's own
    // materialize-db.ts takes the SAME CadDocument row lock, so from this
    // guard's point of view a concurrent materializer looks exactly like a
    // concurrent lock contender that will authoritatively see the SAME
    // "reserved, zero versions" state once it acquires the lock).
    const results = await Promise.allSettled([
      storeCadFileVersionForActor(actor, "doc-reserved", textSource("a"), null, 10_000, db.asUploadGuardDb, storage),
      storeCadFileVersionForActor(actor, "doc-reserved", textSource("b"), null, 10_000, db.asUploadGuardDb, storage),
    ]);

    // BOTH must be rejected - the reserved-target guard is authoritative
    // under the lock and does not depend on which one wins the race.
    assert.ok(results.every((r) => r.status === "rejected"));
    assert.ok(
      results.every((r) => r.status === "rejected" && r.reason instanceof ReservedCopyDesignTargetError),
    );
    assert.equal(db.versions.length, 0, "no FileVersion was ever created by either racing generic upload");
  });
});
