/**
 * Focused tests for frozen release baseline capture
 * (`app/lib/release-db.ts`, P3D-1).
 *
 * Like `checkout-db.test.ts` / `checkin-db.test.ts`, the fake database's
 * `$transaction` + `$queryRaw` ("... FOR UPDATE") simulation uses a REAL
 * per-row async mutex (acquired on the CadDocument lock query, released
 * only when the transaction's callback settles), so the concurrent-release
 * test below genuinely exercises blocking + post-unblock re-evaluation -
 * the SAME shared `lockCadDocumentForVersionMutation` lock direct upload
 * and checkout acquisition also take. A REAL PostgreSQL race is also proven
 * separately in the live integration gate; a fake DB race alone is not the
 * authoritative proof.
 *
 * Storage is a minimal in-memory stub (`objectExists` backed by a Set) -
 * release never streams bytes, it only checks object existence.
 *
 * Run with:  node --experimental-strip-types --test tests/release-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { LifecycleState } from "../app/generated/prisma/enums.ts";
import { isTerminalLifecycle, manualTransitionTargets } from "../app/lib/revisions.ts";
import type { Actor } from "../app/lib/authz.ts";
import type { UserRole } from "../app/generated/prisma/enums.ts";
import {
  ReleaseBaselineIncompleteError,
  advanceRevisionForActor,
  buildReleaseBaselineInTransaction,
  type ReleaseDb,
} from "../app/lib/release-db.ts";

// ------------------------------------------------------------
// Fake database + storage: REAL per-row async mutex behind $transaction +
// $queryRaw("... FOR UPDATE"), matching lockCadDocumentForVersionMutation's
// exact bind order (cadDocumentId, organizationId).
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

interface RevisionRow {
  organizationId: string;
  id: string;
  itemId: string;
  lifecycle: string;
  sourceRevisionId: string | null;
  releasedAt: Date | null;
}
interface LinkRow {
  organizationId: string;
  itemRevisionId: string;
  cadDocumentId: string;
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
interface EntryRow {
  id: string;
  organizationId: string;
  releaseBaselineId: string;
  cadDocumentId: string;
  fileVersionId: string;
}
interface BaselineRow {
  organizationId: string;
  id: string;
  itemRevisionId: string;
  createdById: string;
  createdAt: Date;
}

class FakeDatabase {
  readonly revisions: RevisionRow[] = [];
  readonly links: LinkRow[] = [];
  readonly versions: VersionRow[] = [];
  readonly baselines: BaselineRow[] = [];
  readonly entries: EntryRow[] = [];
  readonly storageObjects = new Set<string>();
  readonly #locks = new Map<string, RowLock>();
  transactionAttempts = 0;
  forceSerializationFailures = 0;

  addRevision(row: RevisionRow): this {
    this.revisions.push(row);
    return this;
  }
  addLink(organizationId: string, itemRevisionId: string, cadDocumentId: string): this {
    this.links.push({ organizationId, itemRevisionId, cadDocumentId });
    return this;
  }
  addVersion(row: Omit<VersionRow, "fileSize"> & { fileSize: number | null }): this {
    this.versions.push({ ...row, fileSize: row.fileSize == null ? null : BigInt(row.fileSize) });
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

  #latestVersionsFor(organizationId: string, cadDocumentId: string): VersionRow[] {
    return this.versions
      .filter((v) => v.organizationId === organizationId && v.cadDocumentId === cadDocumentId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  get provider() {
    const self = this;
    return {
      async exists(key: string): Promise<boolean> {
        return self.storageObjects.has(key);
      },
    };
  }

  get db(): ReleaseDb {
    const self = this;
    return {
      itemRevision: {
        findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
          const row = self.revisions.find(
            (r) => r.id === args.where.id && r.organizationId === args.where.organizationId,
          );
          return row
            ? { id: row.id, itemId: row.itemId, lifecycle: row.lifecycle, sourceRevisionId: row.sourceRevisionId }
            : null;
        }) as unknown as ReleaseDb["itemRevision"]["findFirst"],
      } as unknown as ReleaseDb["itemRevision"],
      itemRevisionDocument: {
        findMany: (async (args: {
          where: { organizationId: string; itemRevisionId: string };
        }) => {
          return self.links
            .filter(
              (l) => l.organizationId === args.where.organizationId && l.itemRevisionId === args.where.itemRevisionId,
            )
            .map((l) => ({ cadDocumentId: l.cadDocumentId }));
        }) as unknown as ReleaseDb["itemRevisionDocument"]["findMany"],
      } as unknown as ReleaseDb["itemRevisionDocument"],
      fileVersion: {
        findMany: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          return self.#latestVersionsFor(args.where.organizationId, args.where.cadDocumentId);
        }) as unknown as ReleaseDb["fileVersion"]["findMany"],
      } as unknown as ReleaseDb["fileVersion"],
      releaseBaseline: {} as unknown as ReleaseDb["releaseBaseline"],
      releaseBaselineEntry: {} as unknown as ReleaseDb["releaseBaselineEntry"],
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
        self.transactionAttempts += 1;
        if (self.forceSerializationFailures > 0) {
          self.forceSerializationFailures -= 1;
          throw new FakeSerializationFailureError();
        }
        const releases: Array<() => void> = [];
        // Direct mutation + an undo log - NOT staged/cloned copies. This
        // matters: the real code's ONLY protection against a concurrent
        // release-vs-release race is the optimistic conditional UPDATE
        // (`WHERE ... lifecycle = <validated state>`), which only works if
        // `updateMany` checks against the CURRENT (possibly just-mutated-by
        // -someone-else) row, not a snapshot frozen at transaction start. A
        // per-transaction clone would silently defeat that exact mechanism
        // and let two concurrent releases both "succeed" in this fake. The
        // undo log instead reverts any writes THIS attempt made if it later
        // throws (rollback semantics), without hiding concurrent writes
        // from in-flight reads.
        const undo: Array<() => void> = [];
        const tx = {
          $queryRaw: (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            const cadDocumentId = values[0] as string;
            const organizationId = values[1] as string;
            const key = `${organizationId}:${cadDocumentId}`;
            const release = await self.#lockFor(key).acquire();
            releases.push(release);
            return [{ id: cadDocumentId, organizationId }];
          }) as unknown,
          itemRevision: {
            findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
              const row = self.revisions.find(
                (r) => r.id === args.where.id && r.organizationId === args.where.organizationId,
              );
              return row
                ? { id: row.id, itemId: row.itemId, lifecycle: row.lifecycle, sourceRevisionId: row.sourceRevisionId }
                : null;
            }) as unknown,
            updateMany: (async (args: {
              where: { id: string; organizationId: string; lifecycle: string };
              data: { lifecycle: string; releasedAt?: Date };
            }) => {
              const row = self.revisions.find(
                (r) =>
                  r.id === args.where.id &&
                  r.organizationId === args.where.organizationId &&
                  r.lifecycle === args.where.lifecycle,
              );
              if (!row) return { count: 0 };
              const prevLifecycle = row.lifecycle;
              const prevReleasedAt = row.releasedAt;
              undo.push(() => {
                row.lifecycle = prevLifecycle;
                row.releasedAt = prevReleasedAt;
              });
              row.lifecycle = args.data.lifecycle;
              if (args.data.releasedAt) row.releasedAt = args.data.releasedAt;
              return { count: 1 };
            }) as unknown,
          },
          itemRevisionDocument: {
            findMany: (async (args: { where: { organizationId: string; itemRevisionId: string } }) => {
              return self.links
                .filter(
                  (l) =>
                    l.organizationId === args.where.organizationId &&
                    l.itemRevisionId === args.where.itemRevisionId,
                )
                .map((l) => ({ cadDocumentId: l.cadDocumentId }));
            }) as unknown,
          },
          fileVersion: {
            findMany: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
              return self.#latestVersionsFor(args.where.organizationId, args.where.cadDocumentId).map((v) => ({
                id: v.id,
                versionNumber: v.versionNumber,
                checksum: v.checksum,
                fileSize: v.fileSize,
                storageKey: v.storageKey,
              }));
            }) as unknown,
          },
          releaseBaseline: {
            create: (async (args: {
              data: { organizationId: string; itemRevisionId: string; createdById: string };
            }) => {
              const conflict = self.baselines.some(
                (b) => b.organizationId === args.data.organizationId && b.itemRevisionId === args.data.itemRevisionId,
              );
              if (conflict) {
                const err = new Error("Unique constraint failed on the (organizationId, itemRevisionId) fields");
                (err as unknown as { code: string }).code = "P2002";
                throw err;
              }
              const baseline: BaselineRow = {
                organizationId: args.data.organizationId,
                id: `rb-${randomBytes(6).toString("hex")}`,
                itemRevisionId: args.data.itemRevisionId,
                createdById: args.data.createdById,
                createdAt: new Date(),
              };
              self.baselines.push(baseline);
              undo.push(() => {
                const idx = self.baselines.indexOf(baseline);
                if (idx >= 0) self.baselines.splice(idx, 1);
              });
              return {
                id: baseline.id,
                itemRevisionId: baseline.itemRevisionId,
                createdById: baseline.createdById,
                createdAt: baseline.createdAt,
              };
            }) as unknown,
          },
          releaseBaselineEntry: {
            createMany: (async (args: {
              data: Array<{
                organizationId: string;
                releaseBaselineId: string;
                cadDocumentId: string;
                fileVersionId: string;
              }>;
            }) => {
              for (const e of args.data) {
                const entry: EntryRow = {
                  id: `rbe-${randomBytes(6).toString("hex")}`,
                  organizationId: e.organizationId,
                  releaseBaselineId: e.releaseBaselineId,
                  cadDocumentId: e.cadDocumentId,
                  fileVersionId: e.fileVersionId,
                };
                self.entries.push(entry);
                undo.push(() => {
                  const idx = self.entries.indexOf(entry);
                  if (idx >= 0) self.entries.splice(idx, 1);
                });
              }
              return { count: args.data.length };
            }) as unknown,
          },
        };
        try {
          return await fn(tx);
        } catch (error) {
          // Rollback: undo every write THIS attempt made, in reverse order.
          for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]!();
          throw error;
        } finally {
          for (const release of releases) release();
        }
      }) as unknown as ReleaseDb["$transaction"],
    } as unknown as ReleaseDb;
  }
}

function actorIn(organizationId: string, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role: "ENGINEER" as UserRole,
    name: "Test User",
    email: `user@${organizationId}.example`,
    ...overrides,
  };
}

function seedApprovedRevision(
  db: FakeDatabase,
  overrides: Partial<RevisionRow> = {},
): RevisionRow {
  const row: RevisionRow = {
    organizationId: "orgA",
    id: "rev-1",
    itemId: "item-1",
    lifecycle: LifecycleState.APPROVED,
    sourceRevisionId: null,
    releasedAt: null,
    ...overrides,
  };
  db.addRevision(row);
  return row;
}

function seedDocumentWithVersion(
  db: FakeDatabase,
  cadDocumentId: string,
  fileVersionId: string,
  versionNumber: number,
  overrides: Partial<{ checksum: string | null; fileSize: number | null; storageKey: string; present: boolean }> = {},
): void {
  const storageKey = overrides.storageKey ?? `org/orgA/doc/${cadDocumentId}/v${versionNumber}/${fileVersionId}`;
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId,
    id: fileVersionId,
    versionNumber,
    checksum: overrides.checksum === undefined ? `checksum-${fileVersionId}` : overrides.checksum,
    fileSize: overrides.fileSize === undefined ? 100 : overrides.fileSize,
    storageKey,
  });
  if (overrides.present !== false) {
    db.storageObjects.add(storageKey);
  }
}

// ------------------------------------------------------------
// 1. Release with one CAD document
// ------------------------------------------------------------

test("release with one CAD document: baseline created, exact FileVersion pinned", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v5", 5);

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.RELEASED);
  assert.equal(db.baselines.length, 1);
  assert.equal(db.entries.length, 1);
  assert.equal(db.entries[0]!.cadDocumentId, "doc-1");
  assert.equal(db.entries[0]!.fileVersionId, "fv-1-v5");
  assert.equal(db.baselines[0]!.itemRevisionId, "rev-1");
  assert.equal(db.baselines[0]!.createdById, actor.userId);
});

// ------------------------------------------------------------
// 2. Release with multiple CAD documents
// ------------------------------------------------------------

test("release with multiple CAD documents: one entry per directly associated document", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-assembly");
  db.addLink("orgA", "rev-1", "doc-frame");
  db.addLink("orgA", "rev-1", "doc-drawing");
  seedDocumentWithVersion(db, "doc-assembly", "fv-assembly-v5", 5);
  seedDocumentWithVersion(db, "doc-frame", "fv-frame-v8", 8);
  seedDocumentWithVersion(db, "doc-drawing", "fv-drawing-v4", 4);

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries.length, 3);
  const byDoc = new Map(db.entries.map((e) => [e.cadDocumentId, e.fileVersionId]));
  assert.equal(byDoc.get("doc-assembly"), "fv-assembly-v5");
  assert.equal(byDoc.get("doc-frame"), "fv-frame-v8");
  assert.equal(byDoc.get("doc-drawing"), "fv-drawing-v4");
});

// ------------------------------------------------------------
// 3. New FileVersion after release -> frozen baseline unchanged
// ------------------------------------------------------------

test("a new FileVersion created after release: the frozen baseline still points to the old pinned version", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v5", 5);

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);
  assert.equal(db.entries[0]!.fileVersionId, "fv-1-v5");

  // Simulate a later check-in / direct upload creating V6 on the SAME
  // document - the example from the task prompt (Assembly V5 -> V6).
  seedDocumentWithVersion(db, "doc-1", "fv-1-v6", 6);

  assert.equal(db.entries.length, 1, "still exactly one entry - no repinning, no second row");
  assert.equal(db.entries[0]!.fileVersionId, "fv-1-v5", "frozen baseline must STILL resolve to the old version");
});

// ------------------------------------------------------------
// 4. Metadata-incomplete newer version
// ------------------------------------------------------------

test("metadata-incomplete newer version: skipped exactly like the shared resolver (Get Latest / Checkout / Check-In)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  // A newer row exists but is metadata-incomplete - must be skipped, not
  // block resolution of the older complete one.
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId: "doc-1",
    id: "fv-1-v2-incomplete",
    versionNumber: 2,
    checksum: null,
    fileSize: null,
    storageKey: "org/orgA/doc/doc-1/v2/incomplete",
  });

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries[0]!.fileVersionId, "fv-1-v1", "the incomplete v2 row must be skipped, exactly like the shared resolver");
});

// ------------------------------------------------------------
// 5. Newest expected metadata-complete binary missing -> release fails
// ------------------------------------------------------------

test("newest expected metadata-complete binary missing: release fails, no fallback, revision not RELEASED, no partial baseline", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  // Older, present binary.
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  // Newest metadata-complete row, but its object was never registered as
  // present - the shared resolver must report missing-binary and refuse to
  // fall back to v1.
  seedDocumentWithVersion(db, "doc-1", "fv-1-v2", 2, { present: false });

  const actor = actorIn("orgA");
  await assert.rejects(
    () => advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseBaselineIncompleteError);
      assert.equal(error.cadDocumentId, "doc-1");
      assert.equal(error.reason, "missing-binary");
      return true;
    },
  );

  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED, "revision must NOT become RELEASED");
  assert.equal(db.baselines.length, 0, "no partial baseline survives");
  assert.equal(db.entries.length, 0, "no partial entries survive");
  assert.notEqual(
    db.entries.some((e) => e.fileVersionId === "fv-1-v1"),
    true,
    "must never silently fall back to the older v1 binary",
  );
});

test("no valid FileVersion at all: release fails cleanly (missing-version), no partial baseline", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-empty");
  // No FileVersion rows for doc-empty at all.

  const actor = actorIn("orgA");
  await assert.rejects(
    () => advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseBaselineIncompleteError);
      assert.equal(error.reason, "missing-version");
      return true;
    },
  );
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
  assert.equal(db.baselines.length, 0);
});

// ------------------------------------------------------------
// 6. Zero CAD associations -> empty baseline
// ------------------------------------------------------------

test("zero CAD associations: release succeeds with an empty immutable baseline", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  // No ItemRevisionDocument links at all.

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.RELEASED);
  assert.equal(db.baselines.length, 1);
  assert.equal(db.entries.length, 0, "empty baseline, not a rejected release");
});

// ------------------------------------------------------------
// 7. Repeated release -> no duplicate baseline, no repinning
// ------------------------------------------------------------

test("repeated release request: no duplicate baseline, no repinning, controlled rejection consistent with the existing lifecycle API", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);
  assert.equal(db.baselines.length, 1);

  // A newer FileVersion appears - a repeat release must NEVER re-resolve
  // and repin it.
  seedDocumentWithVersion(db, "doc-1", "fv-1-v2", 2);

  await assert.rejects(
    () => advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    /Released or terminal revisions cannot be changed/,
  );

  assert.equal(db.baselines.length, 1, "no second baseline");
  assert.equal(db.entries.length, 1, "no repinning");
  assert.equal(db.entries[0]!.fileVersionId, "fv-1-v1");
});

// ------------------------------------------------------------
// 8. Tenant isolation
// ------------------------------------------------------------

test("tenant isolation: a revision in another organization is unreachable, never resolved or released", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db, { organizationId: "orgB" });
  db.addLink("orgB", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  db.versions[0]!.organizationId = "orgB";

  const outsider = actorIn("orgA");
  await assert.rejects(
    () => advanceRevisionForActor(outsider, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    /Revision not found/,
  );
  assert.equal(db.baselines.length, 0);
});

// ------------------------------------------------------------
// 10. Release failure -> predecessor not SUPERSEDED
// ------------------------------------------------------------

test("release failure (missing binary): the predecessor revision is NOT superseded", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db, { id: "rev-source", lifecycle: LifecycleState.RELEASED, releasedAt: new Date() });
  seedApprovedRevision(db, { id: "rev-successor", sourceRevisionId: "rev-source" });
  db.addLink("orgA", "rev-successor", "doc-1");
  // Missing binary -> release must fail.
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1, { present: false });

  const actor = actorIn("orgA");
  await assert.rejects(
    () => advanceRevisionForActor(actor, "rev-successor", LifecycleState.RELEASED, db.db, db.provider),
    ReleaseBaselineIncompleteError,
  );

  const source = db.revisions.find((r) => r.id === "rev-source")!;
  assert.equal(source.lifecycle, LifecycleState.RELEASED, "predecessor must remain RELEASED, not SUPERSEDED");
  const successor = db.revisions.find((r) => r.id === "rev-successor")!;
  assert.equal(successor.lifecycle, LifecycleState.APPROVED, "successor must not become RELEASED");
});

test("successful release DOES supersede an eligible predecessor (existing behavior preserved)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db, { id: "rev-source", lifecycle: LifecycleState.RELEASED, releasedAt: new Date() });
  seedApprovedRevision(db, { id: "rev-successor", sourceRevisionId: "rev-source" });
  db.addLink("orgA", "rev-successor", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-successor", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.revisions.find((r) => r.id === "rev-source")!.lifecycle, LifecycleState.SUPERSEDED);
  assert.equal(db.revisions.find((r) => r.id === "rev-successor")!.lifecycle, LifecycleState.RELEASED);
  assert.equal(db.baselines.length, 1);
});

// ------------------------------------------------------------
// 11. Association mutation vs release: existing protection remains correct
// ------------------------------------------------------------

test("association mutation protection: a RELEASED (terminal) revision has zero manual transition targets and is terminal - the SAME guard linkExistingCadDocumentToRevision/createCadDocument already rely on", () => {
  assert.equal(isTerminalLifecycle(LifecycleState.RELEASED), true);
  assert.deepEqual(manualTransitionTargets(LifecycleState.RELEASED), []);
});

// ------------------------------------------------------------
// CONCURRENCY (fake-DB level; the authoritative proof is the real-
// PostgreSQL live gate, done separately)
// ------------------------------------------------------------

test("concurrent release vs release: exactly one baseline, no duplicate entries, no raw Prisma error", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  const actor = actorIn("orgA");

  const [a, b] = await Promise.allSettled([
    advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
  ]);

  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one racer wins the release");
  assert.equal(rejected.length, 1);
  assert.equal(db.baselines.length, 1, "exactly one baseline");
  assert.equal(db.entries.length, 1, "no duplicate entries");
});

test("multi-document release: deterministic sorted lock order across all associated documents, one coherent baseline", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  // Insert links in a DELIBERATELY non-sorted order.
  db.addLink("orgA", "rev-1", "doc-zebra");
  db.addLink("orgA", "rev-1", "doc-apple");
  db.addLink("orgA", "rev-1", "doc-mango");
  seedDocumentWithVersion(db, "doc-zebra", "fv-zebra", 1);
  seedDocumentWithVersion(db, "doc-apple", "fv-apple", 1);
  seedDocumentWithVersion(db, "doc-mango", "fv-mango", 1);

  const actor = actorIn("orgA");
  await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries.length, 3);
  const pinned = new Set(db.entries.map((e) => e.cadDocumentId));
  assert.deepEqual([...pinned].sort(), ["doc-apple", "doc-mango", "doc-zebra"]);
});

test("exhausted SERIALIZABLE retries on release -> controlled error, never a raw P2034, revision not RELEASED", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  const actor = actorIn("orgA");

  db.forceSerializationFailures = 10;

  let caught: unknown;
  try {
    await advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match((caught as Error).message, /concurrent changes, please retry/);
  assert.doesNotMatch(String((caught as Error).message), /P2034|PrismaClientKnownRequestError/i);
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED, "revision not RELEASED");
  assert.equal(db.baselines.length, 0);
});

// ------------------------------------------------------------
// buildReleaseBaselineInTransaction called directly (lower-level unit)
// ------------------------------------------------------------

test("buildReleaseBaselineInTransaction directly: returns the exact pinned entries with version numbers", async () => {
  const db = new FakeDatabase();
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v3", 3);

  await db.db.$transaction(async (tx) => {
    const result = await buildReleaseBaselineInTransaction(
      tx as never,
      "orgA",
      "rev-1",
      "user-orgA",
      db.provider,
    );
    assert.equal(result.itemRevisionId, "rev-1");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]!.cadDocumentId, "doc-1");
    assert.equal(result.entries[0]!.fileVersionId, "fv-1-v3");
    assert.equal(result.entries[0]!.versionNumber, 3);
  });
});
