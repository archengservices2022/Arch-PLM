/**
 * Focused tests for the PDM CAD Check-In Prisma-shaped wiring
 * (`app/lib/checkin-db.ts`, P3C-2). Like `checkout-db.ts`'s tests, this
 * module deliberately does NOT import "server-only", so it can be exercised
 * directly by the Node test runner with an in-memory fake database.
 *
 * The fake database's `$transaction` + `$queryRaw` (`FOR UPDATE`) simulation
 * uses a REAL per-row async mutex (acquired on the raw lock query, released
 * only when the transaction's callback settles) - not a synchronous
 * check-and-set shortcut - so the double-check-in race test below genuinely
 * exercises blocking + post-unblock re-evaluation, the same shape Postgres
 * gives a `SELECT ... FOR UPDATE` whose row is deleted by the blocking
 * transaction. This is still a FAKE, though: the task's real release gate
 * requires the actual double-check-in race to also be proven against real
 * PostgreSQL (done separately in the live integration gate), per the
 * explicit instruction that "a fake DB race alone is insufficient."
 *
 * Storage is the REAL `LocalFilesystemStorage` against a temp directory
 * (mirroring `tests/storage-core.test.ts`'s `withTmpDir` pattern) rather
 * than a hand-rolled fake, since check-in reuses `uploadCadFileVersion`
 * verbatim and its staging/promotion/compensation behavior is exactly what
 * several tests below need to observe for real.
 *
 * Run with:  node --experimental-strip-types --test tests/checkin-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import { LocalFilesystemStorage } from "../app/lib/storage-core.ts";
import {
  CadDocumentNotFoundError,
  CheckInConcurrencyConflictError,
  CheckInRoleError,
  CheckInVersionRaceError,
  CheckoutOwnershipError,
  EmptyUploadError,
  NotCheckedOutError,
  StaleBaseError,
  UploadTooLargeError,
  checkInForActor,
  checkInHttpResult,
  type CheckInDb,
} from "../app/lib/checkin-db.ts";

// ------------------------------------------------------------
// Temp storage root helper (mirrors tests/storage-core.test.ts)
// ------------------------------------------------------------

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-checkin-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function countStoredObjects(root: string): Promise<number> {
  const orgDir = path.join(root, "org");
  try {
    let count = 0;
    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          count += 1;
        }
      }
    }
    await walk(orgDir);
    return count;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------
// In-memory fake Prisma with a REAL per-row async mutex behind
// $transaction + $queryRaw("... FOR UPDATE"), simulating Postgres row
// locking (not just a synchronous check-and-set shortcut).
// ------------------------------------------------------------

class FakeInjectedDbError extends Error {
  constructor() {
    super("injected DB failure (simulates an unexpected Postgres error)");
  }
}

/** Shaped exactly like the P2034 Prisma raises for a genuine serialization
 *  failure - used to force `runSerializableTransaction`'s retry loop to
 *  exhaust (see the "exhausted SERIALIZABLE conflict" test below). */
class FakeSerializationFailureError extends Error {
  readonly code = "P2034";
  constructor() {
    super("Transaction failed due to a write conflict or a deadlock");
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
  fileSize: bigint | null;
  checksum: string | null;
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

class FakeDatabase {
  readonly docs: DocRow[] = [];
  readonly versions: VersionRow[] = [];
  readonly users: UserRow[] = [];
  readonly checkouts: CheckoutRow[] = [];
  readonly #locks = new Map<string, RowLock>();
  transactionAttempts = 0;
  /** When set, the NEXT tx.fileVersion.create() call throws this instead of
   *  inserting - used to test the "DB failure after promotion succeeded"
   *  compensation path. Consumed (reset to null) on use. */
  injectNextCreateFailure: Error | null = null;
  /** When > 0, the next N `$transaction` calls fail immediately with a
   *  P2034-shaped error (decrementing by one each time) instead of running
   *  the callback - simulates genuine Postgres serialization failures to
   *  exercise the bounded-retry-exhaustion path. */
  forceSerializationFailures = 0;

  addDoc(organizationId: string, id: string, fileName = "part.ipt"): this {
    this.docs.push({ organizationId, id, fileName });
    return this;
  }

  addUser(organizationId: string, id: string, name: string, email: string): this {
    this.users.push({ organizationId, id, name, email });
    return this;
  }

  addVersion(row: Omit<VersionRow, "fileSize"> & { fileSize: number | null }): this {
    this.versions.push({
      ...row,
      fileSize: row.fileSize == null ? null : BigInt(row.fileSize),
    });
    return this;
  }

  addCheckout(row: CheckoutRow): this {
    this.checkouts.push(row);
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

  get db(): CheckInDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
          return (
            self.docs.find(
              (d) => d.id === args.where.id && d.organizationId === args.where.organizationId,
            ) ?? null
          );
        }) as unknown as CheckInDb["cadDocument"]["findFirst"],
      },
      fileVersion: {
        findFirst: (async (args: {
          where: { organizationId: string; cadDocumentId: string };
        }) => {
          const latest = self.#latestVersion(
            args.where.organizationId,
            args.where.cadDocumentId,
          );
          return latest ? { id: latest.id, versionNumber: latest.versionNumber } : null;
        }) as unknown as CheckInDb["fileVersion"]["findFirst"],
      } as unknown as CheckInDb["fileVersion"],
      cadCheckout: {
        findFirst: (async (args: {
          where: { id?: string; organizationId?: string; cadDocumentId?: string };
        }) => {
          const row = args.where.id
            ? self.checkouts.find((c) => c.id === args.where.id)
            : self.checkouts.find(
                (c) =>
                  c.organizationId === args.where.organizationId &&
                  c.cadDocumentId === args.where.cadDocumentId,
              );
          if (!row) return null;
          const user = self.users.find((u) => u.id === row.checkedOutById);
          return {
            id: row.id,
            checkedOutById: row.checkedOutById,
            checkedOutBy: { name: user?.name ?? "", email: user?.email ?? "" },
          };
        }) as unknown as CheckInDb["cadCheckout"]["findFirst"],
      } as unknown as CheckInDb["cadCheckout"],
      $transaction: (async (
        fn: (tx: unknown) => Promise<unknown>,
        _opts?: unknown,
      ) => {
        self.transactionAttempts += 1;
        if (self.forceSerializationFailures > 0) {
          self.forceSerializationFailures -= 1;
          throw new FakeSerializationFailureError();
        }
        const releases: Array<() => void> = [];
        const tx = {
          $queryRaw: (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            const cadDocumentId = values[0] as string;
            const organizationId = values[1] as string;
            const key = `${organizationId}:${cadDocumentId}`;
            const release = await self.#lockFor(key).acquire();
            releases.push(release);
            // Re-evaluate the WHERE clause AFTER acquiring the lock, against
            // current state - mirrors Postgres re-checking a blocked
            // `SELECT ... FOR UPDATE` once the row it waited on is freed.
            const row = self.checkouts.find(
              (c) => c.organizationId === organizationId && c.cadDocumentId === cadDocumentId,
            );
            if (!row) return [];
            return [
              {
                id: row.id,
                baseFileVersionId: row.baseFileVersionId,
                checkedOutById: row.checkedOutById,
              },
            ];
          }) as unknown,
          fileVersion: {
            findFirst: (async (args: {
              where: { organizationId: string; cadDocumentId: string };
            }) => {
              const latest = self.#latestVersion(
                args.where.organizationId,
                args.where.cadDocumentId,
              );
              return latest ? { id: latest.id, versionNumber: latest.versionNumber } : null;
            }) as unknown,
            findMany: (async (args: {
              where: { organizationId: string; cadDocumentId: string };
            }) => {
              return self.versions
                .filter(
                  (v) =>
                    v.organizationId === args.where.organizationId &&
                    v.cadDocumentId === args.where.cadDocumentId,
                )
                .sort((a, b) => b.versionNumber - a.versionNumber)
                .map((v) => ({
                  id: v.id,
                  versionNumber: v.versionNumber,
                  checksum: v.checksum,
                  fileSize: v.fileSize == null ? null : Number(v.fileSize),
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
              if (self.injectNextCreateFailure) {
                const err = self.injectNextCreateFailure;
                self.injectNextCreateFailure = null;
                throw err;
              }
              const conflict = self.versions.some(
                (v) =>
                  v.cadDocumentId === args.data.cadDocumentId &&
                  v.versionNumber === args.data.versionNumber,
              );
              if (conflict) {
                throw new FakeUniqueConstraintError();
              }
              const row: VersionRow = {
                organizationId: args.data.organizationId,
                cadDocumentId: args.data.cadDocumentId,
                id: `fv-${randomBytes(6).toString("hex")}`,
                versionNumber: args.data.versionNumber,
                originalFileName: args.data.originalFileName,
                storageKey: args.data.storageKey,
                fileSize: args.data.fileSize,
                checksum: args.data.checksum,
                createdById: args.data.createdById,
              };
              self.versions.push(row);
              return { id: row.id, versionNumber: row.versionNumber };
            }) as unknown,
          },
          cadCheckout: {
            findFirst: (async (args: { where: { id: string } }) => {
              const row = self.checkouts.find((c) => c.id === args.where.id);
              if (!row) return null;
              const user = self.users.find((u) => u.id === row.checkedOutById);
              return { checkedOutBy: { name: user?.name ?? "", email: user?.email ?? "" } };
            }) as unknown,
            delete: (async (args: { where: { id: string } }) => {
              const idx = self.checkouts.findIndex((c) => c.id === args.where.id);
              if (idx >= 0) self.checkouts.splice(idx, 1);
            }) as unknown,
          },
        };
        try {
          return await fn(tx);
        } finally {
          for (const release of releases) release();
        }
      }) as unknown as CheckInDb["$transaction"],
    } as unknown as CheckInDb;
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

function textSource(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

/** Seed one CAD document with FileVersion v1 (organizationId "orgA", id
 *  "doc-1") and an active checkout owned by `ownerId`, based on v1. Also
 *  returns the caller-visible v1 id for stale-base tests. */
async function seedCheckedOutDocument(
  db: FakeDatabase,
  storage: LocalFilesystemStorage,
  ownerId = "user-orgA",
): Promise<{ v1Id: string; checkoutId: string }> {
  db.addUser("orgA", ownerId, "Owner", "owner@orgA.example");
  db.addDoc("orgA", "doc-1");
  const storageKey = "org/orgA/doc/doc-1/v1/seed0001";
  await storage.put(storageKey, Buffer.from("v1 original bytes"));
  const v1Id = "fv-doc-1-1";
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId: "doc-1",
    id: v1Id,
    versionNumber: 1,
    originalFileName: "part.ipt",
    storageKey,
    fileSize: 18,
    checksum: "seed-checksum",
    createdById: ownerId,
  });
  const checkoutId = `co-${randomBytes(6).toString("hex")}`;
  db.addCheckout({
    organizationId: "orgA",
    id: checkoutId,
    cadDocumentId: "doc-1",
    baseFileVersionId: v1Id,
    checkedOutById: ownerId,
  });
  return { v1Id, checkoutId };
}

// ------------------------------------------------------------
// Successful check-in: V1 -> V2
// ------------------------------------------------------------

test("successful check-in creates exactly one new FileVersion, removes the checkout, and byte/checksum/size/creator are all correct", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    const content = "edited v2 bytes - hello world";
    const result = await checkInForActor(
      actor,
      "doc-1",
      textSource(content),
      1_000_000,
      "part-v2.ipt",
      db.db,
      storage,
    );

    assert.equal(result.versionNumber, 2);
    assert.equal(result.cadDocumentId, "doc-1");
    assert.equal(result.createdById, actor.userId);
    assert.equal(result.fileSize, Buffer.byteLength(content));

    // Exactly one new FileVersion row exists (v1 untouched, v2 added).
    assert.equal(db.versions.length, 2);
    assert.ok(db.versions.some((v) => v.versionNumber === 2 && v.id === result.fileVersionId));

    // Checkout removed only on success.
    assert.equal(db.checkouts.length, 0);

    // Byte-for-byte + checksum correctness via the real storage provider.
    const stored = await storage.get(result.storageKey);
    assert.equal(stored.toString(), content);
    const rehash = await storage.hashObject(result.storageKey);
    assert.equal(rehash.sha256, result.checksum);
    assert.equal(rehash.size, result.fileSize);
  });
});

// ------------------------------------------------------------
// Authorization / tenant isolation
// ------------------------------------------------------------

test("no active checkout -> rejected (409-mapped NotCheckedOutError), no FileVersion created", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addUser("orgA", "user-orgA", "Owner", "o@orgA.example");
    db.addDoc("orgA", "doc-1");
    const actor = actorIn("orgA");

    await assert.rejects(
      () => checkInForActor(actor, "doc-1", textSource("x"), 1000, null, db.db, storage),
      NotCheckedOutError,
    );
    assert.equal(db.versions.length, 0);

    const httpResult = await checkInHttpResult(
      actor,
      "doc-1",
      textSource("x"),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(httpResult.status, 409);
  });
});

test("checked out by another actor -> rejected with tenant-safe lock info, checkout preserved", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-other", "Other Actor", "other@orgA.example");
    const other = actorIn("orgA", { userId: "user-other" });

    await assert.rejects(
      () => checkInForActor(other, "doc-1", textSource("x"), 1000, null, db.db, storage),
      (error: unknown) => {
        assert.ok(error instanceof CheckoutOwnershipError);
        assert.equal(error.checkedOutById, "user-owner");
        return true;
      },
    );
    assert.equal(db.checkouts.length, 1, "checkout preserved on ownership conflict");
    assert.equal(db.versions.length, 1, "no new FileVersion created");
  });
});

test("VIEWER role is denied check-in (403), checkout preserved", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const viewer = actorIn("orgA", { role: UserRole.VIEWER });

    await assert.rejects(
      () => checkInForActor(viewer, "doc-1", textSource("x"), 1000, null, db.db, storage),
      CheckInRoleError,
    );
    assert.equal(db.checkouts.length, 1);

    const httpResult = await checkInHttpResult(
      viewer,
      "doc-1",
      textSource("x"),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(httpResult.status, 403);
  });
});

test("unauthenticated check-in is denied (401), never touches the database", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);

    const result = await checkInHttpResult(
      null,
      "doc-1",
      textSource("x"),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(result.status, 401);
    assert.equal(db.checkouts.length, 1);
    assert.equal(db.versions.length, 1);
  });
});

test("a cross-tenant document is hidden as 404, checkout in the other org untouched", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const outsider = actorIn("orgB");

    await assert.rejects(
      () => checkInForActor(outsider, "doc-1", textSource("x"), 1000, null, db.db, storage),
      CadDocumentNotFoundError,
    );
    assert.equal(db.checkouts.length, 1);

    const httpResult = await checkInHttpResult(
      outsider,
      "doc-1",
      textSource("x"),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(httpResult.status, 404);
    assert.ok(!JSON.stringify(httpResult.body).includes("orgA"));
  });
});

// ------------------------------------------------------------
// Stale base protection
// ------------------------------------------------------------

test("stale base (document changed after checkout via the out-of-band upload path) -> rejected, checkout preserved, no V3 created", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedCheckedOutDocument(db, storage);
    // Simulate a FileVersion appearing behind the checkout's back (e.g. via
    // the checkout-unaware upload endpoint) - the checkout's base is still
    // v1, but the document's current newest is now v2. Its bytes are real
    // and present, so the shared resolver reports it as "ok" (this test
    // exercises the "resolved-but-mismatched-id" branch specifically).
    const outOfBandKey = "org/orgA/doc/doc-1/v2/outofband";
    await storage.put(outOfBandKey, Buffer.from("out of band bytes"));
    db.addVersion({
      organizationId: "orgA",
      cadDocumentId: "doc-1",
      id: "fv-doc-1-2-outofband",
      versionNumber: 2,
      originalFileName: "part.ipt",
      storageKey: outOfBandKey,
      fileSize: 18,
      checksum: "out-of-band",
      createdById: "user-orgA",
    });
    const actor = actorIn("orgA");

    await assert.rejects(
      () => checkInForActor(actor, "doc-1", textSource("edited"), 1000, null, db.db, storage),
      (error: unknown) => {
        assert.ok(error instanceof StaleBaseError);
        assert.equal(error.expectedBaseFileVersionId, v1Id);
        assert.equal(error.actualLatestFileVersionId, "fv-doc-1-2-outofband");
        return true;
      },
    );
    assert.equal(db.checkouts.length, 1, "checkout preserved on stale base");
    assert.equal(db.versions.length, 2, "no V3 created - never silently rebases");

    const httpResult = await checkInHttpResult(
      actor,
      "doc-1",
      textSource("edited"),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(httpResult.status, 409);
  });
});

// ------------------------------------------------------------
// Shared FileVersion resolver semantics (Codex MEDIUM fix): check-in's
// stale-base validation must behave EXACTLY like Checkout / Get Latest for
// the same document states - see tests/file-version-resolution-core.test.ts
// for the shared algorithm itself, and tests/checkout-db.test.ts /
// tests/get-latest-db.test.ts for the same scenarios proven there too.
// ------------------------------------------------------------

test("stale base: the checkout's base version's binary has gone missing from storage -> integrity failure via the shared resolver, checkout preserved", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedCheckedOutDocument(db, storage);
    // The base FileVersion's row still exists with complete metadata, but
    // its bytes were removed from storage after checkout (e.g. a storage
    // incident) - the shared resolver must report missing-binary, NEVER
    // silently fall back and NEVER treat it as still "ok".
    const v1 = db.versions.find((v) => v.id === v1Id)!;
    await storage.delete(v1.storageKey);
    const actor = actorIn("orgA");

    await assert.rejects(
      () => checkInForActor(actor, "doc-1", textSource("edited"), 1000, null, db.db, storage),
      (error: unknown) => {
        assert.ok(error instanceof StaleBaseError);
        assert.equal(error.expectedBaseFileVersionId, v1Id);
        assert.equal(
          error.actualLatestFileVersionId,
          null,
          "missing-binary resolves to no usable current version, not a fabricated id",
        );
        return true;
      },
    );
    assert.equal(db.checkouts.length, 1, "checkout preserved on integrity failure");
    assert.equal(db.versions.length, 1, "no new FileVersion created");
  });
});

test("stale base: no fallback to an older still-present binary when the newest expected version's binary is missing", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedCheckedOutDocument(db, storage);
    // v1 (checkout's base) is complete and present. A v2 was somehow added
    // out-of-band with complete metadata but NO bytes ever stored. The
    // shared resolver must report the problem against v2 (the newest
    // metadata-complete row) and must NOT silently resolve to v1 just
    // because v1's bytes are still there.
    db.addVersion({
      organizationId: "orgA",
      cadDocumentId: "doc-1",
      id: "fv-doc-1-2-missing-binary",
      versionNumber: 2,
      originalFileName: "part.ipt",
      storageKey: "org/orgA/doc/doc-1/v2/never-written",
      fileSize: 20,
      checksum: "c-2",
      createdById: "user-orgA",
    });
    const actor = actorIn("orgA");

    await assert.rejects(
      () => checkInForActor(actor, "doc-1", textSource("edited"), 1000, null, db.db, storage),
      (error: unknown) => {
        assert.ok(error instanceof StaleBaseError);
        assert.equal(error.expectedBaseFileVersionId, v1Id);
        assert.equal(
          error.actualLatestFileVersionId,
          null,
          "must not silently resolve to the older, still-present v1",
        );
        return true;
      },
    );
    assert.equal(db.checkouts.length, 1, "checkout preserved");
    assert.equal(db.versions.length, 2, "no V3 created");
  });
});

test("stale base: a metadata-incomplete newer row is skipped consistently with Checkout / Get Latest - check-in against the older complete base still succeeds", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    // A newer row exists but is metadata-incomplete (e.g. an interrupted
    // legacy write) - the shared resolver skips it entirely, so the
    // checkout's base (v1) is STILL the current usable version and
    // check-in must proceed normally, exactly as Checkout / Get Latest
    // would resolve "current" for this same document state.
    db.addVersion({
      organizationId: "orgA",
      cadDocumentId: "doc-1",
      id: "fv-doc-1-2-incomplete",
      versionNumber: 2,
      originalFileName: "part.ipt",
      storageKey: "org/orgA/doc/doc-1/v2/incomplete",
      fileSize: null,
      checksum: null,
      createdById: "user-orgA",
    });
    const actor = actorIn("orgA");

    const result = await checkInForActor(
      actor,
      "doc-1",
      textSource("edited"),
      1000,
      null,
      db.db,
      storage,
    );

    // The shared resolver skipped the incomplete row, so v1 was still
    // "current" and the new version is allocated as v3 (MAX+1 over the
    // incomplete row's versionNumber 2) - not silently overwriting or
    // renumbering it.
    assert.equal(result.versionNumber, 3);
    assert.equal(db.checkouts.length, 0, "successful check-in removes the checkout");
    assert.equal(
      db.versions.some((v) => v.id === "fv-doc-1-2-incomplete"),
      true,
      "the incomplete row is left untouched, never deleted or overwritten",
    );
  });
});

// ------------------------------------------------------------
// Failure preserves the checkout: oversize, empty, storage/DB failure
// ------------------------------------------------------------

test("oversized upload is rejected (413), checkout preserved, no FileVersion created", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    const big = Readable.from([Buffer.alloc(2000, 7)]);
    await assert.rejects(
      () => checkInForActor(actor, "doc-1", big, 1000, null, db.db, storage),
      UploadTooLargeError,
    );
    assert.equal(db.checkouts.length, 1);
    assert.equal(db.versions.length, 1);

    const httpResult = await checkInHttpResult(
      actor,
      "doc-1",
      Readable.from([Buffer.alloc(2000, 7)]),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(httpResult.status, 413);
  });
});

test("empty upload is rejected (400), checkout preserved", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    await assert.rejects(
      () => checkInForActor(actor, "doc-1", Readable.from([]), 1000, null, db.db, storage),
      EmptyUploadError,
    );
    assert.equal(db.checkouts.length, 1);
    assert.equal(db.versions.length, 1);
  });
});

test("DB failure after storage promotion succeeded -> compensates (deletes the orphaned object), checkout preserved, no FileVersion row", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    db.injectNextCreateFailure = new FakeInjectedDbError();

    await assert.rejects(
      () => checkInForActor(actor, "doc-1", textSource("edited"), 1000, null, db.db, storage),
      FakeInjectedDbError,
    );

    assert.equal(db.checkouts.length, 1, "checkout preserved after DB failure");
    assert.equal(db.versions.length, 1, "no FileVersion row committed");
    // Only the original v1 object remains on disk - the promoted-but-then-
    // rolled-back v2 object was compensated (deleted), no orphan left behind.
    assert.equal(await countStoredObjects(dir), 1);
  });
});

test("exhausted SERIALIZABLE retries -> controlled CheckInConcurrencyConflictError (409), never a raw P2034, checkout preserved, storage compensated", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    // Force every attempt of the bounded retry loop to hit a genuine
    // Postgres-shaped serialization failure, exhausting it.
    db.forceSerializationFailures = 10;

    let caught: unknown;
    try {
      await checkInForActor(actor, "doc-1", textSource("edited"), 1000, null, db.db, storage);
    } catch (error) {
      caught = error;
    }

    assert.ok(
      caught instanceof CheckInConcurrencyConflictError,
      "exhausted retries surface a controlled domain error, not a raw Prisma/P2034 error",
    );
    assert.doesNotMatch(
      String((caught as Error).message),
      /P2034|PrismaClientKnownRequestError|deadlock/i,
      "the controlled error never leaks Prisma internals",
    );

    assert.equal(db.checkouts.length, 1, "checkout preserved after exhausted retries");
    assert.equal(db.versions.length, 1, "no FileVersion row created by the failed request");
    // No orphan: nothing beyond the original v1 object remains on disk -
    // every attempt's promoted-then-doomed object was compensated.
    assert.equal(await countStoredObjects(dir), 1);

    const httpResult = await checkInHttpResult(
      actor,
      "doc-1",
      textSource("edited"),
      null,
      1000,
      db.db,
      storage,
    );
    assert.equal(httpResult.status, 409);
    assert.ok(!JSON.stringify(httpResult.body).match(/P2034|PrismaClientKnownRequestError/i));
  });
});

// ------------------------------------------------------------
// Concurrency: double check-in race (fake-DB level; the authoritative
// proof is the real-PostgreSQL live gate, done separately)
// ------------------------------------------------------------

test("double/concurrent check-in race: exactly one FileVersion is created, the loser gets a controlled conflict, no orphan binary", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    const [first, second] = await Promise.allSettled([
      checkInForActor(actor, "doc-1", textSource("racer A content"), 10_000, null, db.db, storage),
      checkInForActor(actor, "doc-1", textSource("racer B content"), 10_000, null, db.db, storage),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one racer wins the check-in");
    assert.equal(rejected.length, 1, "the other racer observes a controlled conflict");
    assert.ok(
      (rejected[0] as PromiseRejectedResult).reason instanceof NotCheckedOutError,
      "loser fails cleanly - no raw Prisma error, no duplicate version",
    );

    // Exactly one new FileVersion (v2) - v1 plus the single winner's v2.
    assert.equal(db.versions.length, 2);
    assert.equal(db.versions.filter((v) => v.versionNumber === 2).length, 1);

    // Checkout consumed by the winner.
    assert.equal(db.checkouts.length, 0);

    // No orphan binary from the loser: exactly the v1 seed object plus the
    // winner's v2 object remain on disk.
    assert.equal(await countStoredObjects(dir), 2);

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ storageKey: string }>).value;
    assert.ok(await storage.exists(winner.storageKey));
  });
});

// ------------------------------------------------------------
// No ItemRevision / lifecycle mutation - structural guarantee
// ------------------------------------------------------------

test("CheckInDb has no itemRevision/cadDependency access at all", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");
    await checkInForActor(actor, "doc-1", textSource("x"), 1000, null, db.db, storage);

    const dbAny = db.db as unknown as Record<string, unknown>;
    assert.equal(dbAny.itemRevision, undefined);
    assert.equal(dbAny.cadDependency, undefined);
  });
});
