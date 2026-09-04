/**
 * Focused tests for Undo Checkout / Admin Unlock / checkout history
 * (`app/lib/checkout-release-db.ts`, P3C-3).
 *
 * Like `checkout-db.test.ts` / `checkin-db.test.ts`, the fake database's
 * `$transaction` + `$queryRaw` ("... FOR UPDATE") simulation uses a REAL
 * per-row async mutex (acquired on the CadCheckout lock query, released
 * only when the transaction's callback settles), so the race tests below
 * genuinely exercise blocking + post-unblock re-evaluation - the SAME
 * shared `lockActiveCadCheckout` lock Check-In also takes. This single fake
 * database is deliberately shaped to satisfy BOTH `CheckoutReleaseDb` and
 * `CheckInDb`, so the cross-module races (Check-In vs Undo, Check-In vs
 * Admin Unlock) can be proven here too - not just Undo vs Admin Unlock. A
 * REAL PostgreSQL race is also proven separately in the live integration
 * gate; a fake DB race alone is not the authoritative proof for any of
 * these.
 *
 * Storage is a minimal stub (Check-In's storage calls are exercised
 * elsewhere in `checkin-db.test.ts`) - just enough for `checkInForActor` to
 * complete its staging/promotion steps against a real temp directory.
 *
 * Run with:  node --experimental-strip-types --test tests/checkout-release-db.test.ts
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
import { checkInForActor, type CheckInDb } from "../app/lib/checkin-db.ts";
import {
  AdminUnlockRoleError,
  CadDocumentNotFoundError,
  CheckoutOwnershipError,
  CheckoutReleaseConcurrencyConflictError,
  InvalidReasonError,
  NotCheckedOutError,
  UndoCheckoutRoleError,
  adminUnlockCheckoutForActor,
  adminUnlockHttpResult,
  getCheckoutHistoryForActor,
  getCheckoutHistoryHttpResult,
  undoCheckoutForActor,
  undoCheckoutHttpResult,
  type CheckoutReleaseDb,
} from "../app/lib/checkout-release-db.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-checkout-release-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------
// Shared fake database: satisfies CheckoutReleaseDb AND CheckInDb, with a
// REAL per-row async mutex behind $transaction + $queryRaw("... FOR
// UPDATE"), matching lockActiveCadCheckout's exact bind order
// (cadDocumentId, organizationId).
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

class FakeSerializationFailureError extends Error {
  readonly code = "P2034";
  constructor() {
    super("Transaction failed due to a write conflict or a deadlock");
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
  checkedOutAt: Date;
}
interface EventRow {
  id: string;
  organizationId: string;
  cadDocumentId: string;
  checkoutId: string;
  baseFileVersionId: string;
  checkoutOwnerId: string;
  actedById: string;
  eventType: string;
  checkedOutAt: Date;
  occurredAt: Date;
  reason: string | null;
}

class FakeDatabase {
  readonly docs: DocRow[] = [];
  readonly versions: VersionRow[] = [];
  readonly users: UserRow[] = [];
  readonly checkouts: CheckoutRow[] = [];
  readonly events: EventRow[] = [];
  readonly #locks = new Map<string, RowLock>();
  transactionAttempts = 0;
  forceSerializationFailures = 0;

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

  get db(): CheckoutReleaseDb & CheckInDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
          return self.docs.find((d) => d.id === args.where.id && d.organizationId === args.where.organizationId) ?? null;
        }) as unknown as CheckInDb["cadDocument"]["findFirst"],
      },
      fileVersion: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          const latest = self.#latestVersion(args.where.organizationId, args.where.cadDocumentId);
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
                (c) => c.organizationId === args.where.organizationId && c.cadDocumentId === args.where.cadDocumentId,
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
      cadCheckoutEvent: {
        findMany: (async (args: {
          where: { organizationId: string; cadDocumentId: string };
          orderBy: Array<{ occurredAt?: "desc" | "asc"; id?: "desc" | "asc" }>;
          take: number;
        }) => {
          return self.events
            .filter((e) => e.organizationId === args.where.organizationId && e.cadDocumentId === args.where.cadDocumentId)
            .sort((a, b) => {
              for (const clause of args.orderBy) {
                if (clause.occurredAt) {
                  const diff = a.occurredAt.getTime() - b.occurredAt.getTime();
                  if (diff !== 0) return clause.occurredAt === "desc" ? -diff : diff;
                }
                if (clause.id) {
                  const diff = a.id.localeCompare(b.id);
                  if (diff !== 0) return clause.id === "desc" ? -diff : diff;
                }
              }
              return 0;
            })
            .slice(0, args.take)
            .map((e) => {
              const version = self.versions.find((v) => v.id === e.baseFileVersionId);
              return { ...e, baseFileVersion: { versionNumber: version?.versionNumber ?? 0 } };
            });
        }) as unknown,
      } as unknown as CheckInDb["cadCheckoutEvent"],
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
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
            const row = self.checkouts.find(
              (c) => c.organizationId === organizationId && c.cadDocumentId === cadDocumentId,
            );
            if (!row) return [];
            return [
              {
                id: row.id,
                baseFileVersionId: row.baseFileVersionId,
                checkedOutById: row.checkedOutById,
                checkedOutAt: row.checkedOutAt,
              },
            ];
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
          cadCheckoutEvent: {
            create: (async (args: {
              data: {
                organizationId: string;
                cadDocumentId: string;
                checkoutId: string;
                baseFileVersionId: string;
                checkoutOwnerId: string;
                actedById: string;
                eventType: string;
                checkedOutAt: Date;
                reason?: string | null;
              };
            }) => {
              const row: EventRow = {
                id: `ev-${randomBytes(6).toString("hex")}`,
                organizationId: args.data.organizationId,
                cadDocumentId: args.data.cadDocumentId,
                checkoutId: args.data.checkoutId,
                baseFileVersionId: args.data.baseFileVersionId,
                checkoutOwnerId: args.data.checkoutOwnerId,
                actedById: args.data.actedById,
                eventType: args.data.eventType,
                checkedOutAt: args.data.checkedOutAt,
                occurredAt: new Date(),
                reason: args.data.reason ?? null,
              };
              self.events.push(row);
              return { id: row.id };
            }) as unknown,
          },
        };
        try {
          return await fn(tx);
        } finally {
          for (const release of releases) release();
        }
      }) as unknown as CheckInDb["$transaction"],
    } as unknown as CheckoutReleaseDb & CheckInDb;
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
    checkedOutAt: new Date(),
  });
  return { v1Id, checkoutId };
}

// ------------------------------------------------------------
// UNDO CHECKOUT
// ------------------------------------------------------------

test("owner undo succeeds: checkout removed, no FileVersion created, audit event correct", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id, checkoutId } = await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    const result = await undoCheckoutForActor(actor, "doc-1", "changed my mind", db.db);

    assert.equal(result.checkoutId, checkoutId);
    assert.equal(result.baseFileVersionId, v1Id);
    assert.equal(result.previousOwnerId, actor.userId);
    assert.equal(result.reason, "changed my mind");
    assert.equal(db.checkouts.length, 0, "checkout removed");
    assert.equal(db.versions.length, 1, "no FileVersion created");

    assert.equal(db.events.length, 1);
    const event = db.events[0]!;
    assert.equal(event.eventType, "UNDO_CHECKOUT");
    assert.equal(event.checkoutOwnerId, actor.userId);
    assert.equal(event.actedById, actor.userId);
    assert.equal(event.reason, "changed my mind");
  });
});

test("undo with no reason succeeds (reason is optional)", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    const result = await undoCheckoutForActor(actor, "doc-1", undefined, db.db);
    assert.equal(result.reason, null);
    assert.equal(db.events[0]!.reason, null);
  });
});

test("another actor cannot undo someone else's checkout", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-other", "Other", "other@orgA.example");
    const other = actorIn("orgA", { userId: "user-other" });

    await assert.rejects(
      () => undoCheckoutForActor(other, "doc-1", null, db.db),
      (error: unknown) => {
        assert.ok(error instanceof CheckoutOwnershipError);
        assert.equal(error.checkedOutById, "user-owner");
        return true;
      },
    );
    assert.equal(db.checkouts.length, 1, "checkout preserved");
    assert.equal(db.events.length, 0, "no audit event from a rejected undo");
  });
});

test("VIEWER is denied undo (403)", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const viewer = actorIn("orgA", { role: UserRole.VIEWER });

    await assert.rejects(() => undoCheckoutForActor(viewer, "doc-1", null, db.db), UndoCheckoutRoleError);
    const httpResult = await undoCheckoutHttpResult(viewer, "doc-1", null, db.db);
    assert.equal(httpResult.status, 403);
  });
});

test("unauthenticated undo is denied (401), never touches the database", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);

    const result = await undoCheckoutHttpResult(null, "doc-1", null, db.db);
    assert.equal(result.status, 401);
    assert.equal(db.checkouts.length, 1);
  });
});

test("cross-tenant document is hidden (404) for undo", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const outsider = actorIn("orgB");

    await assert.rejects(() => undoCheckoutForActor(outsider, "doc-1", null, db.db), CadDocumentNotFoundError);
    const httpResult = await undoCheckoutHttpResult(outsider, "doc-1", null, db.db);
    assert.equal(httpResult.status, 404);
    assert.ok(!JSON.stringify(httpResult.body).includes("orgA"));
  });
});

test("no active checkout => controlled 409, not a crash", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addUser("orgA", "user-orgA", "Owner", "owner@orgA.example");
    db.addDoc("orgA", "doc-1");
    const actor = actorIn("orgA");

    await assert.rejects(() => undoCheckoutForActor(actor, "doc-1", null, db.db), NotCheckedOutError);
    const httpResult = await undoCheckoutHttpResult(actor, "doc-1", null, db.db);
    assert.equal(httpResult.status, 409);
  });
});

// ------------------------------------------------------------
// ADMIN UNLOCK
// ------------------------------------------------------------

test("ADMIN force-unlock succeeds: checkout removed, no FileVersion, audit captures previous owner + admin actor + reason", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    const { v1Id } = await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
    const admin = actorIn("orgA", { userId: "user-admin", role: UserRole.ADMIN });

    const result = await adminUnlockCheckoutForActor(admin, "doc-1", "owner is on leave, needed for release", db.db);

    assert.equal(result.previousOwnerId, "user-owner");
    assert.equal(result.baseFileVersionId, v1Id);
    assert.equal(db.checkouts.length, 0);
    assert.equal(db.versions.length, 1, "no FileVersion created");

    assert.equal(db.events.length, 1);
    const event = db.events[0]!;
    assert.equal(event.eventType, "ADMIN_UNLOCK");
    assert.equal(event.checkoutOwnerId, "user-owner", "previous owner recorded");
    assert.equal(event.actedById, "user-admin", "acting admin recorded, distinct from the owner");
    assert.equal(event.reason, "owner is on leave, needed for release");
  });
});

test("ENGINEER cannot force-unlock another actor's checkout (403), checkout preserved", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-engineer", "Engineer", "eng@orgA.example");
    const engineer = actorIn("orgA", { userId: "user-engineer", role: UserRole.ENGINEER });

    await assert.rejects(
      () => adminUnlockCheckoutForActor(engineer, "doc-1", "trying anyway", db.db),
      AdminUnlockRoleError,
    );
    assert.equal(db.checkouts.length, 1);
    assert.equal(db.events.length, 0);

    const httpResult = await adminUnlockHttpResult(engineer, "doc-1", "trying anyway", db.db);
    assert.equal(httpResult.status, 403);
  });
});

test("VIEWER is denied admin-unlock (403)", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    const viewer = actorIn("orgA", { role: UserRole.VIEWER });

    await assert.rejects(
      () => adminUnlockCheckoutForActor(viewer, "doc-1", "reason", db.db),
      AdminUnlockRoleError,
    );
  });
});

test("admin-unlock reason is required: missing/empty reason is rejected (400) before touching the database", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
    const admin = actorIn("orgA", { userId: "user-admin", role: UserRole.ADMIN });

    await assert.rejects(() => adminUnlockCheckoutForActor(admin, "doc-1", undefined, db.db), InvalidReasonError);
    await assert.rejects(() => adminUnlockCheckoutForActor(admin, "doc-1", "   ", db.db), InvalidReasonError);
    await assert.rejects(() => adminUnlockCheckoutForActor(admin, "doc-1", 12345, db.db), InvalidReasonError);
    assert.equal(db.checkouts.length, 1, "checkout untouched by a rejected request");

    const httpResult = await adminUnlockHttpResult(admin, "doc-1", undefined, db.db);
    assert.equal(httpResult.status, 400);
  });
});

test("admin-unlock reason is trimmed and bounded", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
    const admin = actorIn("orgA", { userId: "user-admin", role: UserRole.ADMIN });

    const result = await adminUnlockCheckoutForActor(admin, "doc-1", "   padded reason   ", db.db);
    assert.equal(result.reason, "padded reason");

    // Bounded: a reason far beyond the cap is rejected, not silently
    // truncated.
    const huge = "x".repeat(5000);
    await withTmpDir(async (dir2) => {
      const storage2 = new LocalFilesystemStorage(dir2);
      const db2 = new FakeDatabase();
      await seedCheckedOutDocument(db2, storage2, "user-owner");
      db2.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
      await assert.rejects(
        () => adminUnlockCheckoutForActor(admin, "doc-1", huge, db2.db),
        InvalidReasonError,
      );
    });
  });
});

test("cross-tenant document is hidden (404) for admin-unlock, another org's ADMIN cannot reach it", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    const outsiderAdmin = actorIn("orgB", { role: UserRole.ADMIN });

    await assert.rejects(
      () => adminUnlockCheckoutForActor(outsiderAdmin, "doc-1", "reason", db.db),
      CadDocumentNotFoundError,
    );
  });
});

test("admin-unlock with no active checkout => controlled 409", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    db.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
    db.addDoc("orgA", "doc-1");
    const admin = actorIn("orgA", { userId: "user-admin", role: UserRole.ADMIN });

    await assert.rejects(() => adminUnlockCheckoutForActor(admin, "doc-1", "reason", db.db), NotCheckedOutError);
  });
});

// ------------------------------------------------------------
// AUDIT / HISTORY
// ------------------------------------------------------------

test("history: tenant isolation - a cross-tenant document's history is unreachable (404)", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    const outsider = actorIn("orgB");

    await assert.rejects(() => getCheckoutHistoryForActor(outsider, "doc-1", db.db), CadDocumentNotFoundError);
    const httpResult = await getCheckoutHistoryHttpResult(outsider, "doc-1", undefined, db.db);
    assert.equal(httpResult.status, 404);
  });
});

test("history: newest first, bounded, reflects CHECKED_OUT then UNDO_CHECKOUT", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    const owner = actorIn("orgA", { userId: "user-owner" });

    // Seed a CHECKED_OUT event to represent the acquisition (checkout-db.ts
    // itself is what records this in production - here we just prove the
    // history reader surfaces it correctly, newest-first).
    db.events.push({
      id: "ev-checkout",
      organizationId: "orgA",
      cadDocumentId: "doc-1",
      checkoutId: db.checkouts[0]!.id,
      baseFileVersionId: "fv-doc-1-1",
      checkoutOwnerId: "user-owner",
      actedById: "user-owner",
      eventType: "CHECKED_OUT",
      checkedOutAt: db.checkouts[0]!.checkedOutAt,
      occurredAt: new Date(Date.now() - 10_000),
      reason: null,
    });

    await undoCheckoutForActor(owner, "doc-1", "done editing", db.db);

    const history = await getCheckoutHistoryForActor(owner, "doc-1", db.db);
    assert.equal(history.length, 2);
    assert.equal(history[0]!.eventType, "UNDO_CHECKOUT", "newest first");
    assert.equal(history[1]!.eventType, "CHECKED_OUT");
    assert.equal(history[0]!.baseVersionNumber, 1);

    // Bounded: requesting far more than exist never errors, and requesting
    // a tiny limit clamps the result.
    const bounded = await getCheckoutHistoryForActor(owner, "doc-1", db.db, 1);
    assert.equal(bounded.length, 1);
    assert.equal(bounded[0]!.eventType, "UNDO_CHECKOUT");

    const overRequested = await getCheckoutHistoryForActor(owner, "doc-1", db.db, 999999);
    assert.equal(overRequested.length, 2, "clamped to what actually exists, never an error");
  });
});

test("history: events sharing the exact same occurredAt are still ordered deterministically via id DESC", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");

    // Three events pinned to the IDENTICAL timestamp (a real DateTime(3)
    // column can genuinely tie under fast concurrent writes) but with
    // distinct, non-monotonically-inserted ids. occurredAt alone cannot
    // order these; id DESC must.
    const tiedAt = new Date("2026-01-01T00:00:00.000Z");
    const base = {
      organizationId: "orgA",
      cadDocumentId: "doc-1",
      checkoutId: db.checkouts[0]!.id,
      baseFileVersionId: "fv-doc-1-1",
      checkoutOwnerId: "user-owner",
      actedById: "user-owner",
      checkedOutAt: db.checkouts[0]!.checkedOutAt,
      occurredAt: tiedAt,
      reason: null,
    };
    // Pushed out of id order on purpose - the fake's sort must not rely on
    // insertion/array order to get this right.
    db.events.push({ ...base, id: "ev-b", eventType: "UNDO_CHECKOUT" });
    db.events.push({ ...base, id: "ev-a", eventType: "CHECKED_OUT" });
    db.events.push({ ...base, id: "ev-c", eventType: "ADMIN_UNLOCK" });

    const owner = actorIn("orgA", { userId: "user-owner" });
    const history = await getCheckoutHistoryForActor(owner, "doc-1", db.db);

    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((h) => h.id),
      ["ev-c", "ev-b", "ev-a"],
      "same occurredAt -> id DESC breaks the tie deterministically",
    );
  });
});

test("failed undo/admin-unlock operations create no terminal audit event (already proven per-branch above); a successful Check-In records exactly one CHECKED_IN event", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    const owner = actorIn("orgA", { userId: "user-owner" });

    await checkInForActor(owner, "doc-1", textSource("edited"), 10_000, null, db.db, storage);

    assert.equal(db.events.length, 1);
    assert.equal(db.events[0]!.eventType, "CHECKED_IN");
    assert.equal(db.checkouts.length, 0);
    assert.equal(db.versions.length, 2);
  });
});

// ------------------------------------------------------------
// CONCURRENCY (fake-DB level; the authoritative proof is the real-
// PostgreSQL live gate, done separately)
// ------------------------------------------------------------

test("Undo vs Admin Unlock race: exactly one wins, the loser gets a controlled conflict, exactly one release audit event", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
    const owner = actorIn("orgA", { userId: "user-owner" });
    const admin = actorIn("orgA", { userId: "user-admin", role: UserRole.ADMIN });

    const [undoResult, unlockResult] = await Promise.allSettled([
      undoCheckoutForActor(owner, "doc-1", "undo racer", db.db),
      adminUnlockCheckoutForActor(admin, "doc-1", "unlock racer", db.db),
    ]);

    const fulfilled = [undoResult, unlockResult].filter((r) => r.status === "fulfilled");
    const rejected = [undoResult, unlockResult].filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one release operation wins");
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof NotCheckedOutError);

    assert.equal(db.checkouts.length, 0, "checkout consumed by the winner");
    assert.equal(db.events.length, 1, "exactly one release audit event");
    assert.ok(["UNDO_CHECKOUT", "ADMIN_UNLOCK"].includes(db.events[0]!.eventType));
  });
});

test("Check-In vs Undo Checkout race: exactly one wins, never both a new FileVersion AND a successful undo for the same checkout", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    const owner = actorIn("orgA", { userId: "user-owner" });

    const [checkInResult, undoResult] = await Promise.allSettled([
      checkInForActor(owner, "doc-1", textSource("checked in content"), 10_000, null, db.db, storage),
      undoCheckoutForActor(owner, "doc-1", "undo racer", db.db),
    ]);

    const fulfilled = [checkInResult, undoResult].filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "exactly one of check-in/undo wins");
    assert.equal(db.checkouts.length, 0);

    if (checkInResult.status === "fulfilled") {
      assert.equal(db.versions.length, 2);
      assert.equal(db.events.length, 1);
      assert.equal(db.events[0]!.eventType, "CHECKED_IN");
      assert.ok(undoResult.status === "rejected" && undoResult.reason instanceof NotCheckedOutError);
    } else {
      assert.equal(db.versions.length, 1, "no FileVersion created when undo won");
      assert.equal(db.events.length, 1);
      assert.equal(db.events[0]!.eventType, "UNDO_CHECKOUT");
      assert.ok(checkInResult.status === "rejected");
    }
  });
});

test("Check-In vs Admin Unlock race: exactly one wins, no inconsistent state", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage, "user-owner");
    db.addUser("orgA", "user-admin", "Admin", "admin@orgA.example");
    const owner = actorIn("orgA", { userId: "user-owner" });
    const admin = actorIn("orgA", { userId: "user-admin", role: UserRole.ADMIN });

    const [checkInResult, unlockResult] = await Promise.allSettled([
      checkInForActor(owner, "doc-1", textSource("checked in content"), 10_000, null, db.db, storage),
      adminUnlockCheckoutForActor(admin, "doc-1", "forcing unlock", db.db),
    ]);

    const fulfilled = [checkInResult, unlockResult].filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    assert.equal(db.checkouts.length, 0);
    assert.equal(db.events.length, 1, "exactly one terminal audit event, never two");

    if (checkInResult.status === "fulfilled") {
      assert.equal(db.versions.length, 2);
      assert.equal(db.events[0]!.eventType, "CHECKED_IN");
    } else {
      assert.equal(db.versions.length, 1);
      assert.equal(db.events[0]!.eventType, "ADMIN_UNLOCK");
    }
  });
});

test("exhausted SERIALIZABLE retries on undo -> controlled CheckoutReleaseConcurrencyConflictError (409), checkout preserved", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const db = new FakeDatabase();
    await seedCheckedOutDocument(db, storage);
    const actor = actorIn("orgA");

    db.forceSerializationFailures = 10;

    let caught: unknown;
    try {
      await undoCheckoutForActor(actor, "doc-1", null, db.db);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CheckoutReleaseConcurrencyConflictError);
    assert.doesNotMatch(String((caught as Error).message), /P2034|PrismaClientKnownRequestError/i);
    assert.equal(db.checkouts.length, 1, "checkout preserved");
    assert.equal(db.events.length, 0, "no audit event from an exhausted-retry failure");

    const httpResult = await undoCheckoutHttpResult(actor, "doc-1", null, db.db);
    assert.equal(httpResult.status, 409);
  });
});
