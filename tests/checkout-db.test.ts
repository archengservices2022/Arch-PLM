/**
 * Focused tests for the PDM CAD Checkout Prisma-shaped wiring
 * (`app/lib/checkout-db.ts`, P3C-1). Like `get-latest-db.ts` /
 * `workspace-plan-db.ts`, this module deliberately does NOT import
 * "server-only" (only type-only `Actor` / `PrismaClient` imports, erased at
 * compile time, plus a relative-`.ts` runtime import of the generated
 * `UserRole` enum), so it can be exercised directly by the Node test runner
 * with an in-memory fake database and a fake actor.
 *
 * The fake database's `cadCheckout.create()` faithfully simulates Postgres's
 * `(organizationId, cadDocumentId)` unique-constraint behavior (throwing a
 * P2002-shaped error on a second insert for the same pair), so the
 * concurrency test below genuinely exercises the same
 * check-then-reconcile logic `checkout-db.ts` would run against a real
 * database - it is not merely asserting against a hand-waved assumption.
 *
 * Run with:  node --experimental-strip-types --test tests/checkout-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import type { StorageProvider } from "../app/lib/storage-core.ts";
import {
  CadDocumentNotFoundError,
  CheckoutConflictError,
  CheckoutRoleError,
  NoValidFileVersionError,
  getCheckoutStatusForActor,
  getCheckoutStatusHttpResult,
  requestCheckoutForActor,
  requestCheckoutHttpResult,
  type CheckoutDb,
} from "../app/lib/checkout-db.ts";

// ------------------------------------------------------------
// In-memory fake Prisma + storage provider
// ------------------------------------------------------------

class FakeP2002Error extends Error {
  readonly code = "P2002";
  constructor() {
    super("Unique constraint failed on the (organizationId, cadDocumentId) fields");
  }
}

interface DocRow {
  organizationId: string;
  id: string;
}
interface VersionRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: bigint | null;
  storageKey: string;
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
  note: string | null;
}

class FakeDatabase {
  readonly docs: DocRow[] = [];
  readonly versions: VersionRow[] = [];
  readonly users: UserRow[] = [];
  readonly checkouts: CheckoutRow[] = [];
  createAttempts = 0;

  addDoc(organizationId: string, id: string): this {
    this.docs.push({ organizationId, id });
    return this;
  }

  addUser(organizationId: string, id: string, name: string, email: string): this {
    this.users.push({ organizationId, id, name, email });
    return this;
  }

  addVersion(row: Omit<VersionRow, "fileSize"> & { fileSize: number | null }): this {
    this.versions.push({ ...row, fileSize: row.fileSize == null ? null : BigInt(row.fileSize) });
    return this;
  }

  #hydrate(row: CheckoutRow) {
    const version = this.versions.find((v) => v.id === row.baseFileVersionId);
    const user = this.users.find((u) => u.id === row.checkedOutById);
    if (!version || !user) {
      throw new Error("fake db inconsistency: dangling checkout reference");
    }
    return {
      id: row.id,
      cadDocumentId: row.cadDocumentId,
      baseFileVersionId: row.baseFileVersionId,
      checkedOutById: row.checkedOutById,
      checkedOutAt: row.checkedOutAt,
      note: row.note,
      baseFileVersion: { versionNumber: version.versionNumber },
      checkedOutBy: { name: user.name, email: user.email },
    };
  }

  get db(): CheckoutDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
          return (
            self.docs.find(
              (d) => d.id === args.where.id && d.organizationId === args.where.organizationId,
            ) ?? null
          );
        }) as unknown as CheckoutDb["cadDocument"]["findFirst"],
      },
      fileVersion: {
        findMany: (async (args: {
          where: { organizationId: string; cadDocumentId: string };
        }) => {
          return self.versions
            .filter(
              (v) =>
                v.organizationId === args.where.organizationId &&
                v.cadDocumentId === args.where.cadDocumentId,
            )
            .sort((a, b) => b.versionNumber - a.versionNumber);
        }) as unknown as CheckoutDb["fileVersion"]["findMany"],
      },
      cadCheckout: {
        findFirst: (async (args: {
          where: { organizationId: string; cadDocumentId: string };
        }) => {
          const row = self.checkouts.find(
            (c) =>
              c.organizationId === args.where.organizationId &&
              c.cadDocumentId === args.where.cadDocumentId,
          );
          return row ? self.#hydrate(row) : null;
        }) as unknown as CheckoutDb["cadCheckout"]["findFirst"],
        create: (async (args: {
          data: {
            organizationId: string;
            cadDocumentId: string;
            baseFileVersionId: string;
            checkedOutById: string;
          };
        }) => {
          self.createAttempts += 1;
          // Faithfully simulate the (organizationId, cadDocumentId) unique
          // index: check-and-insert as one synchronous, non-interruptible
          // step (no `await` in between), exactly like a real unique index
          // gives Postgres.
          const conflict = self.checkouts.some(
            (c) =>
              c.organizationId === args.data.organizationId &&
              c.cadDocumentId === args.data.cadDocumentId,
          );
          if (conflict) {
            throw new FakeP2002Error();
          }
          const row: CheckoutRow = {
            organizationId: args.data.organizationId,
            id: `co-${randomBytes(6).toString("hex")}`,
            cadDocumentId: args.data.cadDocumentId,
            baseFileVersionId: args.data.baseFileVersionId,
            checkedOutById: args.data.checkedOutById,
            checkedOutAt: new Date(),
            note: null,
          };
          self.checkouts.push(row);
          return self.#hydrate(row);
        }) as unknown as CheckoutDb["cadCheckout"]["create"],
      },
    } as unknown as CheckoutDb;
  }
}

class FakeProvider implements Pick<StorageProvider, "exists"> {
  readonly objects = new Set<string>();
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

function actorIn(
  organizationId: string,
  overrides: Partial<Actor> = {},
): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role: UserRole.ENGINEER,
    name: "Test User",
    email: `user@${organizationId}.example`,
    ...overrides,
  };
}

/** Seed one CAD document with a single, real, present binary-backed
 *  FileVersion (v1) - the common "checkout should just work" fixture. */
function seedDocumentWithVersion(
  db: FakeDatabase,
  provider: FakeProvider,
  organizationId: string,
  docId: string,
): void {
  db.addDoc(organizationId, docId);
  const storageKey = `org/${organizationId}/doc/${docId}/v1/aaaa1111`;
  db.addVersion({
    organizationId,
    cadDocumentId: docId,
    id: `fv-${docId}-1`,
    versionNumber: 1,
    checksum: `c-${docId}-1`,
    fileSize: 1234,
    storageKey,
  });
  provider.objects.add(storageKey);
}

// ------------------------------------------------------------
// Successful checkout + exact base FileVersion captured
// ------------------------------------------------------------

test("successful checkout captures the exact current base FileVersion", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");
  // A second, newer version - this must be the captured base, not v1.
  const storageKeyV2 = "org/orgA/doc/doc-1/v2/bbbb2222";
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId: "doc-1",
    id: "fv-doc-1-2",
    versionNumber: 2,
    checksum: "c-doc-1-2",
    fileSize: 2222,
    storageKey: storageKeyV2,
  });
  provider.objects.add(storageKeyV2);

  const actor = actorIn("orgA");
  const outcome = await requestCheckoutForActor(actor, "doc-1", db.db, provider);

  assert.equal(outcome.status, "created");
  assert.equal(outcome.checkout.cadDocumentId, "doc-1");
  assert.equal(outcome.checkout.baseFileVersionId, "fv-doc-1-2");
  assert.equal(outcome.checkout.baseVersionNumber, 2);
  assert.equal(outcome.checkout.checkedOutById, actor.userId);
  assert.equal(outcome.checkout.checkedOutByName, "Actor A");
  assert.ok(!Number.isNaN(Date.parse(outcome.checkout.checkedOutAt)));
  assert.equal(db.checkouts.length, 1);
});

// ------------------------------------------------------------
// Idempotency (same actor) vs conflict (different actor)
// ------------------------------------------------------------

test("same-user checkout is idempotent: returns the existing checkout, does not create another", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");
  const actor = actorIn("orgA");

  const first = await requestCheckoutForActor(actor, "doc-1", db.db, provider);
  assert.equal(first.status, "created");

  const second = await requestCheckoutForActor(actor, "doc-1", db.db, provider);
  assert.equal(second.status, "already-mine");
  assert.equal(second.checkout.id, first.checkout.id);
  assert.equal(db.checkouts.length, 1, "no second row was created");
});

test("different-user checkout attempt fails with a conflict carrying tenant-safe lock info", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-a", "Actor A", "a@orgA.example");
  db.addUser("orgA", "user-b", "Actor B", "b@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");

  const actorA = actorIn("orgA", { userId: "user-a" });
  const actorB = actorIn("orgA", { userId: "user-b" });

  await requestCheckoutForActor(actorA, "doc-1", db.db, provider);

  await assert.rejects(
    () => requestCheckoutForActor(actorB, "doc-1", db.db, provider),
    (error: unknown) => {
      assert.ok(error instanceof CheckoutConflictError);
      assert.equal(error.checkout.checkedOutById, "user-a");
      assert.equal(error.checkout.checkedOutByName, "Actor A");
      return true;
    },
  );
  assert.equal(db.checkouts.length, 1);
});

// ------------------------------------------------------------
// Concurrency: two users racing must never both win
// ------------------------------------------------------------

test("concurrent two-user race on the same document: exactly one active checkout is ever created", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-a", "Actor A", "a@orgA.example");
  db.addUser("orgA", "user-b", "Actor B", "b@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");

  const actorA = actorIn("orgA", { userId: "user-a" });
  const actorB = actorIn("orgA", { userId: "user-b" });

  const [resultA, resultB] = await Promise.allSettled([
    requestCheckoutForActor(actorA, "doc-1", db.db, provider),
    requestCheckoutForActor(actorB, "doc-1", db.db, provider),
  ]);

  const outcomes = [resultA, resultB];
  const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
  const rejected = outcomes.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "exactly one racer wins the checkout");
  assert.equal(rejected.length, 1, "the other racer observes a conflict");
  assert.ok(
    (rejected[0] as PromiseRejectedResult).reason instanceof CheckoutConflictError,
  );
  assert.equal(db.checkouts.length, 1, "only one CadCheckout row ever exists");
  assert.equal(db.createAttempts, 2, "both racers attempted the insert - the constraint, not luck, decided");
});

test("many-way concurrent race on the same document still yields exactly one winner", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  const actors: Actor[] = [];
  for (let i = 0; i < 8; i += 1) {
    db.addUser("orgA", `user-${i}`, `Actor ${i}`, `u${i}@orgA.example`);
    actors.push(actorIn("orgA", { userId: `user-${i}` }));
  }
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");

  const results = await Promise.allSettled(
    actors.map((actor) => requestCheckoutForActor(actor, "doc-1", db.db, provider)),
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  assert.equal(db.checkouts.length, 1);
});

// ------------------------------------------------------------
// Authorization / tenant isolation
// ------------------------------------------------------------

test("VIEWER role is denied checkout", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Viewer", "v@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");
  const viewer = actorIn("orgA", { role: UserRole.VIEWER });

  await assert.rejects(
    () => requestCheckoutForActor(viewer, "doc-1", db.db, provider),
    CheckoutRoleError,
  );
  assert.equal(db.checkouts.length, 0);

  const httpResult = await requestCheckoutHttpResult(viewer, "doc-1", db.db, provider);
  assert.equal(httpResult.status, 403);
});

test("unauthenticated checkout request is denied (401), never touches the database", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");

  const result = await requestCheckoutHttpResult(null, "doc-1", db.db, provider);
  assert.equal(result.status, 401);
  assert.equal(db.createAttempts, 0);
});

test("a cross-tenant document is hidden as 404, never leaked, checkout never attempted", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgB", "user-orgB", "Actor B", "b@orgB.example");
  seedDocumentWithVersion(db, provider, "orgB", "doc-secret");

  const actorA = actorIn("orgA");
  await assert.rejects(
    () => requestCheckoutForActor(actorA, "doc-secret", db.db, provider),
    CadDocumentNotFoundError,
  );
  assert.equal(db.checkouts.length, 0);

  const httpResult = await requestCheckoutHttpResult(actorA, "doc-secret", db.db, provider);
  assert.equal(httpResult.status, 404);
  assert.ok(!JSON.stringify(httpResult.body).includes("orgB"));
});

// ------------------------------------------------------------
// No valid FileVersion / missing-binary handling
// ------------------------------------------------------------

test("a document with no FileVersion at all is rejected (422), not silently checked out", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  db.addDoc("orgA", "doc-empty");
  const actor = actorIn("orgA");

  await assert.rejects(
    () => requestCheckoutForActor(actor, "doc-empty", db.db, provider),
    NoValidFileVersionError,
  );
  assert.equal(db.checkouts.length, 0);

  const httpResult = await requestCheckoutHttpResult(actor, "doc-empty", db.db, provider);
  assert.equal(httpResult.status, 422);
});

test("a document whose latest metadata references a missing binary is handled safely (422, no checkout)", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  db.addDoc("orgA", "doc-1");
  // Metadata looks complete, but the object was never registered as present.
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId: "doc-1",
    id: "fv-doc-1-1",
    versionNumber: 1,
    checksum: "c-1",
    fileSize: 100,
    storageKey: "org/orgA/doc/doc-1/v1/missing",
  });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => requestCheckoutForActor(actor, "doc-1", db.db, provider),
    NoValidFileVersionError,
  );
  assert.equal(db.checkouts.length, 0);
});

test("no fallback to an older present binary when the newest expected version is missing", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1"); // v1: complete + present
  // v2: complete metadata, but bytes never registered as present.
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId: "doc-1",
    id: "fv-doc-1-2",
    versionNumber: 2,
    checksum: "c-2",
    fileSize: 200,
    storageKey: "org/orgA/doc/doc-1/v2/missing",
  });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => requestCheckoutForActor(actor, "doc-1", db.db, provider),
    NoValidFileVersionError,
    "must not silently check out against the older v1 binary",
  );
  assert.equal(db.checkouts.length, 0);
});

// ------------------------------------------------------------
// Status / read API
// ------------------------------------------------------------

test("status: available when no checkout exists", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");
  const actor = actorIn("orgA");

  const status = await getCheckoutStatusForActor(actor, "doc-1", db.db);
  assert.deepEqual(status, { state: "available" });

  const httpResult = await getCheckoutStatusHttpResult(actor, "doc-1", db.db);
  assert.equal(httpResult.status, 200);
  assert.deepEqual(httpResult.body, { state: "available" });
});

test("status: mine when the current actor holds the checkout", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");
  const actor = actorIn("orgA");

  await requestCheckoutForActor(actor, "doc-1", db.db, provider);
  const status = await getCheckoutStatusForActor(actor, "doc-1", db.db);
  assert.equal(status.state, "mine");
  if (status.state === "mine") {
    assert.equal(status.checkout.checkedOutById, actor.userId);
  }
});

test("status: locked by another actor", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-a", "Actor A", "a@orgA.example");
  db.addUser("orgA", "user-b", "Actor B", "b@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");

  const actorA = actorIn("orgA", { userId: "user-a" });
  const actorB = actorIn("orgA", { userId: "user-b" });
  await requestCheckoutForActor(actorA, "doc-1", db.db, provider);

  const status = await getCheckoutStatusForActor(actorB, "doc-1", db.db);
  assert.equal(status.state, "locked");
  if (status.state === "locked") {
    assert.equal(status.checkout.checkedOutById, "user-a");
    assert.equal(status.checkout.checkedOutByName, "Actor A");
  }

  const httpResult = await getCheckoutStatusHttpResult(actorB, "doc-1", db.db);
  assert.equal(httpResult.status, 200);
  const body = httpResult.body as { state: string };
  assert.equal(body.state, "locked");
});

test("status request for a cross-tenant document is a 404, unauthenticated status request is 401", async () => {
  const db = new FakeDatabase();
  db.addUser("orgB", "user-orgB", "Actor B", "b@orgB.example");
  db.addDoc("orgB", "doc-secret");
  const actorA = actorIn("orgA");

  await assert.rejects(
    () => getCheckoutStatusForActor(actorA, "doc-secret", db.db),
    CadDocumentNotFoundError,
  );

  const anon = await getCheckoutStatusHttpResult(null, "doc-1", db.db);
  assert.equal(anon.status, 401);
});

// ------------------------------------------------------------
// No ItemRevision / lifecycle / FileVersion / CadDependency mutation
// ------------------------------------------------------------

test("a successful checkout never mutates FileVersion rows, and the CheckoutDb surface has no ItemRevision/CadDependency access at all", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addUser("orgA", "user-orgA", "Actor A", "a@orgA.example");
  seedDocumentWithVersion(db, provider, "orgA", "doc-1");
  const actor = actorIn("orgA");

  const versionsBefore = JSON.stringify(
    db.versions,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  const docsBefore = JSON.stringify(db.docs);

  await requestCheckoutForActor(actor, "doc-1", db.db, provider);

  const versionsAfter = JSON.stringify(
    db.versions,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  const docsAfter = JSON.stringify(db.docs);

  assert.equal(versionsBefore, versionsAfter, "FileVersion rows are untouched");
  assert.equal(docsBefore, docsAfter, "CadDocument rows are untouched");

  // Structural guarantee: CheckoutDb is typed as exactly
  // Pick<PrismaClient, "cadDocument" | "fileVersion" | "cadCheckout"> - there
  // is no "itemRevision" / "cadDependency" delegate in this type for any
  // checkout code to even call. The fake above deliberately implements only
  // these three, so any accidental reference to a fourth delegate would
  // throw immediately rather than silently succeed.
  const dbAny = db.db as unknown as Record<string, unknown>;
  assert.equal(dbAny.itemRevision, undefined);
  assert.equal(dbAny.cadDependency, undefined);
});
