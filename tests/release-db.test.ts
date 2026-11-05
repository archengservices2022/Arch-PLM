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
  LifecyclePermissionError,
  ReleaseBaselineIncompleteError,
  ReleaseClosureInvalidError,
  ReleaseClosureTooLargeError,
  advanceRevisionForActor,
  buildReleaseBaselineInTransaction,
  type ReleaseDb,
} from "../app/lib/release-db.ts";
import {
  InvalidLifecycleCommentError,
  MAX_LIFECYCLE_COMMENT_LENGTH,
} from "../app/lib/lifecycle-policy-core.ts";

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
  /** B03: NULL = pre-lineage revision with no recorded creator. */
  createdById?: string | null;
  /** B03 (NO-GO finding 1): an ItemRevisionLegacyLifecycleHold row exists. */
  legacyHold?: boolean;
  /** Option A: this revision is the successor of a revalidated legacy revision. */
  revalidatedFrom?: { legacyRevisionId: string; actedById: string };
}
/** B03: the acting-user row re-read inside the transaction. */
interface UserRow {
  organizationId: string;
  id: string;
  role: string;
  active: boolean;
}
/** B03: ItemRevisionLifecycleEvent. */
interface EventRow {
  id: string;
  /** Database-assigned order (BIGSERIAL), the ONLY ordering used. */
  sequence: bigint;
  organizationId: string;
  itemRevisionId: string;
  fromState: string;
  toState: string;
  trigger: string;
  actedById: string;
  actedByRole: string;
  comment: string | null;
  occurredAt: Date;
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
interface DocRow {
  organizationId: string;
  id: string;
}
interface DependencyRow {
  organizationId: string;
  parentDocumentId: string;
  childDocumentId: string;
}
interface EntryRow {
  id: string;
  organizationId: string;
  releaseBaselineId: string;
  cadDocumentId: string;
  fileVersionId: string;
  inclusionKind: "DIRECT" | "DEPENDENCY";
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
  readonly docs: DocRow[] = [];
  readonly dependencies: DependencyRow[] = [];
  readonly baselines: BaselineRow[] = [];
  readonly entries: EntryRow[] = [];
  readonly users: UserRow[] = [];
  readonly events: EventRow[] = [];
  readonly storageObjects = new Set<string>();
  /** storageKey -> the bytes the storage layer would report (defaults to the
   *  FileVersion row's own checksum/size; corruption tests override). */
  readonly storedBytes = new Map<string, { sha256: string; size: number }>();
  readonly #locks = new Map<string, RowLock>();
  transactionAttempts = 0;
  forceSerializationFailures = 0;
  /** Invoked at the start of every in-transaction CadDependency scan, with a
   *  1-based scan counter - lets a test simulate a concurrent edge insert
   *  landing between the release's closure passes. */
  dependencyScanHook: ((scanCount: number) => void) | null = null;
  #dependencyScans = 0;

  addRevision(row: RevisionRow): this {
    this.revisions.push(row);
    return this;
  }
  /** B03: register (or replace) a user row. */
  addUser(organizationId: string, id: string, role: string, active = true): this {
    const existing = this.users.findIndex((u) => u.organizationId === organizationId && u.id === id);
    if (existing >= 0) this.users.splice(existing, 1);
    this.users.push({ organizationId, id, role, active });
    return this;
  }
  /** B03: the database sequence behind ItemRevisionLifecycleEvent.sequence.
   *  Like PostgreSQL, a value is consumed even if its transaction rolls back. */
  #nextSequence = 1n;
  nextSequence(): bigint {
    const value = this.#nextSequence;
    this.#nextSequence += 1n;
    return value;
  }
  /** B03: seed a historical lifecycle event (as if written by an earlier
   *  transaction). `sequence` defaults to the next database value; tests may
   *  pass an explicit one. */
  addEvent(
    row: Omit<EventRow, "id" | "sequence" | "trigger" | "comment" | "actedByRole"> & Partial<EventRow>,
  ): this {
    // An explicit seeded value moves the sequence past it (like setval), so a
    // later live write is always ordered after every existing row - exactly
    // what the real BIGSERIAL guarantees.
    if (row.sequence !== undefined && row.sequence >= this.#nextSequence) {
      this.#nextSequence = row.sequence + 1n;
    }
    this.events.push({
      id: `ev-${randomBytes(6).toString("hex")}`,
      sequence: row.sequence ?? this.nextSequence(),
      trigger: "MANUAL",
      comment: null,
      actedByRole: "APPROVER",
      ...row,
    } as EventRow);
    return this;
  }
  eventsFor(itemRevisionId: string): EventRow[] {
    return this.events.filter((e) => e.itemRevisionId === itemRevisionId);
  }
  addLink(organizationId: string, itemRevisionId: string, cadDocumentId: string): this {
    this.links.push({ organizationId, itemRevisionId, cadDocumentId });
    return this;
  }
  addDoc(organizationId: string, id: string): this {
    if (!this.docs.some((d) => d.organizationId === organizationId && d.id === id)) {
      this.docs.push({ organizationId, id });
    }
    return this;
  }
  addDependency(organizationId: string, parentDocumentId: string, childDocumentId: string): this {
    this.dependencies.push({ organizationId, parentDocumentId, childDocumentId });
    return this;
  }
  addVersion(
    row: Omit<VersionRow, "fileSize"> & { fileSize: number | null },
    opts: { present?: boolean; storedAs?: { sha256?: string; size?: number } } = {},
  ): this {
    this.versions.push({ ...row, fileSize: row.fileSize == null ? null : BigInt(row.fileSize) });
    this.addDoc(row.organizationId, row.cadDocumentId);
    if (opts.present !== false) {
      this.storageObjects.add(row.storageKey);
      this.storedBytes.set(row.storageKey, {
        sha256: opts.storedAs?.sha256 ?? row.checksum ?? "",
        size: opts.storedAs?.size ?? (row.fileSize == null ? 0 : row.fileSize),
      });
    }
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
      async hashObject(key: string): Promise<{ sha256: string; size: number }> {
        const bytes = self.storedBytes.get(key);
        if (!bytes) {
          throw new Error("storage object not found");
        }
        return { sha256: bytes.sha256, size: bytes.size };
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
      user: {} as unknown as ReleaseDb["user"],
      itemRevisionLifecycleEvent: {} as unknown as ReleaseDb["itemRevisionLifecycleEvent"],
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
          user: {
            // B03: the acting user is re-read inside the transaction.
            findFirst: (async (args: { where: { id: string; organizationId: string; active: boolean } }) => {
              const row = self.users.find(
                (u) =>
                  u.id === args.where.id &&
                  u.organizationId === args.where.organizationId &&
                  u.active === args.where.active,
              );
              return row ? { id: row.id, role: row.role } : null;
            }) as unknown,
          },
          itemRevisionLifecycleEvent: {
            findMany: (async (args: { where: { organizationId: string; itemRevisionId: string } }) => {
              return self.events
                .filter(
                  (e) =>
                    e.organizationId === args.where.organizationId &&
                    e.itemRevisionId === args.where.itemRevisionId,
                )
                .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0))
                .map((e) => ({
                  sequence: e.sequence,
                  fromState: e.fromState,
                  toState: e.toState,
                  actedById: e.actedById,
                }));
            }) as unknown,
            create: (async (args: { data: Omit<EventRow, "id" | "sequence"> }) => {
              const row: EventRow = {
                id: `ev-${randomBytes(6).toString("hex")}`,
                sequence: self.nextSequence(),
                ...args.data,
              };
              self.events.push(row);
              undo.push(() => {
                const idx = self.events.indexOf(row);
                if (idx >= 0) self.events.splice(idx, 1);
              });
              return row;
            }) as unknown,
          },
          itemRevision: {
            findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
              const row = self.revisions.find(
                (r) => r.id === args.where.id && r.organizationId === args.where.organizationId,
              );
              return row
                ? {
                    id: row.id,
                    itemId: row.itemId,
                    lifecycle: row.lifecycle,
                    sourceRevisionId: row.sourceRevisionId,
                    createdById: row.createdById ?? null,
                    legacyLifecycleHold: row.legacyHold ? { itemRevisionId: row.id } : null,
                    legacyRevalidationAsSuccessor: (() => {
                      if (!row.revalidatedFrom) return null;
                      const legacy = self.revisions.find((r) => r.id === row.revalidatedFrom!.legacyRevisionId)!;
                      return {
                        actedById: row.revalidatedFrom.actedById,
                        legacyRevision: {
                          id: legacy.id,
                          itemId: legacy.itemId,
                          createdById: legacy.createdById ?? null,
                          sourceRevisionId: legacy.sourceRevisionId,
                        },
                      };
                    })(),
                  }
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
          cadDocument: {
            findMany: (async (args: { where: { organizationId: string; id: { in: string[] } } }) => {
              const ids = new Set(args.where.id.in);
              return self.docs
                .filter((d) => d.organizationId === args.where.organizationId && ids.has(d.id))
                .map((d) => ({ id: d.id }));
            }) as unknown,
          },
          cadDependency: {
            findMany: (async (args: {
              where: { organizationId: string; parentDocumentId: { in: string[] } };
            }) => {
              self.#dependencyScans += 1;
              self.dependencyScanHook?.(self.#dependencyScans);
              const parents = new Set(args.where.parentDocumentId.in);
              return self.dependencies
                .filter(
                  (e) =>
                    e.organizationId === args.where.organizationId &&
                    parents.has(e.parentDocumentId),
                )
                .map((e) => ({
                  parentDocumentId: e.parentDocumentId,
                  childDocumentId: e.childDocumentId,
                }));
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
                inclusionKind: "DIRECT" | "DEPENDENCY";
              }>;
            }) => {
              for (const e of args.data) {
                const entry: EntryRow = {
                  id: `rbe-${randomBytes(6).toString("hex")}`,
                  organizationId: e.organizationId,
                  releaseBaselineId: e.releaseBaselineId,
                  cadDocumentId: e.cadDocumentId,
                  fileVersionId: e.fileVersionId,
                  inclusionKind: e.inclusionKind,
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

// B03 FIXTURE UPDATE (Product Owner decision D-A): release is restricted to
// APPROVER / ADMIN, never the creator or a submitter, and only for a revision
// whose APPROVED state was recorded. The release tests below are about the
// frozen baseline, not about who may release, so their default actor is now
// an eligible APPROVER (previously ENGINEER, which B03 refuses), and
// `seedApprovedRevision` seeds a revision created by a different user,
// submitted by a third user and approved by the releasing APPROVER (D-A6
// allows the same eligible person to approve and release). No baseline
// assertion is changed. The authorization rules themselves are tested in the
// "B03" section at the end of this file and in lifecycle-policy-core.test.ts.
function actorIn(organizationId: string, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role: "APPROVER" as UserRole,
    name: "Test User",
    email: `user@${organizationId}.example`,
    ...overrides,
  };
}

/** Fixed, increasing timestamps for seeded history (before any live write). */
const SEED_TIME = Date.UTC(2026, 0, 1);
function seedTime(minutes: number): Date {
  return new Date(SEED_TIME + minutes * 60_000);
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
  const org = row.organizationId;
  if (row.createdById === undefined) row.createdById = `creator-${org}`;
  db.addRevision(row);
  // The default releasing actor (`actorIn(org)`) is an active APPROVER.
  if (!db.users.some((u) => u.organizationId === org && u.id === `user-${org}`)) {
    db.addUser(org, `user-${org}`, "APPROVER");
  }
  if (row.lifecycle === LifecycleState.APPROVED) {
    db.addEvent({
      organizationId: org,
      itemRevisionId: row.id,
      fromState: LifecycleState.WORKING,
      toState: LifecycleState.IN_REVIEW,
      actedById: `submitter-${org}`,
      actedByRole: "ENGINEER",
      occurredAt: seedTime(1),
    });
    db.addEvent({
      organizationId: org,
      itemRevisionId: row.id,
      fromState: LifecycleState.IN_REVIEW,
      toState: LifecycleState.APPROVED,
      actedById: `user-${org}`,
      occurredAt: seedTime(2),
    });
  }
  return row;
}

function seedDocumentWithVersion(
  db: FakeDatabase,
  cadDocumentId: string,
  fileVersionId: string,
  versionNumber: number,
  overrides: Partial<{
    checksum: string | null;
    fileSize: number | null;
    storageKey: string;
    present: boolean;
    storedAs: { sha256?: string; size?: number };
  }> = {},
): void {
  const storageKey = overrides.storageKey ?? `org/orgA/doc/${cadDocumentId}/v${versionNumber}/${fileVersionId}`;
  db.addVersion(
    {
      organizationId: "orgA",
      cadDocumentId,
      id: fileVersionId,
      versionNumber,
      checksum: overrides.checksum === undefined ? `checksum-${fileVersionId}` : overrides.checksum,
      fileSize: overrides.fileSize === undefined ? 100 : overrides.fileSize,
      storageKey,
    },
    { present: overrides.present, storedAs: overrides.storedAs },
  );
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
    assert.equal(result.entries[0]!.inclusionKind, "DIRECT");
  });
});

// ============================================================
// P3D-3: dependency-complete release closure
// ============================================================

function kindByDoc(db: FakeDatabase): Record<string, string> {
  return Object.fromEntries(db.entries.map((e) => [e.cadDocumentId, e.inclusionKind]));
}
function versionByDoc(db: FakeDatabase): Record<string, string> {
  return Object.fromEntries(db.entries.map((e) => [e.cadDocumentId, e.fileVersionId]));
}

// B. A -> B  =>  A DIRECT, B DEPENDENCY
test("B. direct A depends on B: baseline freezes A (DIRECT) and B (DEPENDENCY)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA1", 1);
  seedDocumentWithVersion(db, "B", "fvB1", 1);
  db.addDependency("orgA", "A", "B");

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries.length, 2);
  assert.deepEqual(kindByDoc(db), { A: "DIRECT", B: "DEPENDENCY" });
});

// C. A -> B -> C  =>  complete recursive closure frozen
test("C. A -> B -> C: the whole recursive closure is frozen", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA1", 1);
  seedDocumentWithVersion(db, "B", "fvB1", 1);
  seedDocumentWithVersion(db, "C", "fvC1", 1);
  db.addDependency("orgA", "A", "B");
  db.addDependency("orgA", "B", "C");

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.deepEqual(kindByDoc(db), { A: "DIRECT", B: "DEPENDENCY", C: "DEPENDENCY" });
  assert.deepEqual(versionByDoc(db), { A: "fvA1", B: "fvB1", C: "fvC1" });
});

// D. diamond  =>  shared leaf frozen once
test("D. diamond A->B, A->C, B->D, C->D: D is frozen exactly once", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  for (const [d, fv] of [["A", "fvA"], ["B", "fvB"], ["C", "fvC"], ["D", "fvD"]] as const) {
    seedDocumentWithVersion(db, d, fv, 1);
  }
  db.addDependency("orgA", "A", "B");
  db.addDependency("orgA", "A", "C");
  db.addDependency("orgA", "B", "D");
  db.addDependency("orgA", "C", "D");

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries.length, 4);
  assert.equal(db.entries.filter((e) => e.cadDocumentId === "D").length, 1);
  assert.equal(kindByDoc(db).D, "DEPENDENCY");
});

// E. a document both direct and reachable as a dependency  =>  one entry, DIRECT wins
test("E. a document that is both directly associated and a dependency child: one entry, DIRECT wins", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  db.addLink("orgA", "rev-1", "B"); // B is ALSO direct
  seedDocumentWithVersion(db, "A", "fvA", 1);
  seedDocumentWithVersion(db, "B", "fvB", 1);
  db.addDependency("orgA", "A", "B");

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries.length, 2);
  assert.equal(db.entries.filter((e) => e.cadDocumentId === "B").length, 1);
  assert.deepEqual(kindByDoc(db), { A: "DIRECT", B: "DIRECT" });
});

// F. cycle in the dependency graph  =>  release still terminates and freezes each node once
test("F. a pre-existing dependency cycle: release terminates and freezes each closure node once", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  seedDocumentWithVersion(db, "B", "fvB", 1);
  db.addDependency("orgA", "A", "B");
  db.addDependency("orgA", "B", "A"); // cycle

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.equal(db.entries.length, 2);
  assert.deepEqual(kindByDoc(db), { A: "DIRECT", B: "DEPENDENCY" });
});

// G. dependency missing a valid FileVersion  =>  release fails atomically
test("G. a dependency document with no usable FileVersion: release fails, revision not RELEASED, no partial baseline", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  db.addDoc("orgA", "B"); // B exists but has no FileVersion
  db.addDependency("orgA", "A", "B");

  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseBaselineIncompleteError);
      assert.equal(error.cadDocumentId, "B");
      assert.equal(error.reason, "missing-version");
      return true;
    },
  );
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
  assert.equal(db.baselines.length, 0);
  assert.equal(db.entries.length, 0);
});

// H. dependency expected binary missing  =>  release fails atomically
test("H. a dependency document whose current FileVersion has no stored binary: release fails atomically", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  seedDocumentWithVersion(db, "B", "fvB", 1, { present: false });
  db.addDependency("orgA", "A", "B");

  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseBaselineIncompleteError);
      assert.equal(error.cadDocumentId, "B");
      assert.equal(error.reason, "missing-binary");
      return true;
    },
  );
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
  assert.equal(db.baselines.length, 0);
});

// I. dependency binary checksum/size mismatch  =>  release fails atomically
test("I. a dependency document whose stored bytes fail checksum verification: release fails atomically (corrupt)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  seedDocumentWithVersion(db, "B", "fvB", 1, { storedAs: { sha256: "not-the-recorded-digest" } });
  db.addDependency("orgA", "A", "B");

  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseBaselineIncompleteError);
      assert.equal(error.cadDocumentId, "B");
      assert.equal(error.reason, "corrupt");
      assert.ok(!error.message.includes("not-the-recorded-digest"));
      return true;
    },
  );
  assert.equal(db.baselines.length, 0);
});

test("I2. a same-size corrupted DIRECT binary also fails release (byte-level check, not just size)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1, { fileSize: 100, storedAs: { sha256: "wrong", size: 100 } });

  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseBaselineIncompleteError);
      assert.equal(error.reason, "corrupt");
      return true;
    },
  );
});

// Closure exceeding the node cap  =>  release fails atomically
test("dependency closure exceeding the node cap: release fails atomically (ReleaseClosureTooLargeError)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  for (const d of ["A", "B", "C", "D"]) seedDocumentWithVersion(db, d, `fv${d}`, 1);
  db.addDependency("orgA", "A", "B");
  db.addDependency("orgA", "A", "C");
  db.addDependency("orgA", "A", "D");

  await assert.rejects(
    () =>
      db.db.$transaction((tx) =>
        buildReleaseBaselineInTransaction(tx as never, "orgA", "rev-1", "user-orgA", db.provider, 2),
      ),
    ReleaseClosureTooLargeError,
  );
  assert.equal(db.baselines.length, 0);
});

// A dependency edge pointing at a document not in the tenant  =>  release fails
test("a dependency edge to a document absent from the organization: release fails atomically (ReleaseClosureInvalidError)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  // Edge A -> ghost, but no CadDocument row for "ghost".
  db.addDependency("orgA", "A", "ghost");

  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseClosureInvalidError);
      assert.equal(error.cadDocumentId, "ghost");
      return true;
    },
  );
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
  assert.equal(db.baselines.length, 0);
});

// O (mechanism). An edge inserted between the release's closure passes is
// picked up by the stabilization re-scan; the frozen package is coherent
// with the AFTER-insert graph, never a torn subset.
test("O. a dependency edge that lands between closure passes is absorbed; the package is coherent, never torn", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  seedDocumentWithVersion(db, "B", "fvB", 1);
  seedDocumentWithVersion(db, "C", "fvC", 1);
  db.addDependency("orgA", "A", "B");
  // After the FIRST in-transaction dependency scan, a concurrent writer adds
  // B -> C (as if createCadDependency had just committed).
  db.dependencyScanHook = (scan) => {
    if (scan === 1) db.addDependency("orgA", "B", "C");
  };

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, db.db, db.provider);

  assert.deepEqual(kindByDoc(db), { A: "DIRECT", B: "DEPENDENCY", C: "DEPENDENCY" },
    "the late B->C edge is absorbed - C is frozen, not silently dropped");
});

// P. simultaneous release attempts on the same revision  =>  exactly one baseline
test("P. simultaneous releases of a revision with a dependency closure: exactly one immutable baseline", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "A");
  seedDocumentWithVersion(db, "A", "fvA", 1);
  seedDocumentWithVersion(db, "B", "fvB", 1);
  db.addDependency("orgA", "A", "B");
  const actor = actorIn("orgA");

  const results = await Promise.allSettled([
    advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    advanceRevisionForActor(actor, "rev-1", LifecycleState.RELEASED, db.db, db.provider),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.baselines.length, 1);
  assert.equal(db.entries.length, 2, "one coherent 2-doc closure, no duplicate entries");
});

// Deterministic lock order across the WHOLE closure (direct + dependency).
test("locks every closure document (direct AND dependency) in one ascending-id order", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "m-root");
  seedDocumentWithVersion(db, "m-root", "fv-root", 1);
  seedDocumentWithVersion(db, "z-dep", "fv-z", 1);
  seedDocumentWithVersion(db, "a-dep", "fv-a", 1);
  db.addDependency("orgA", "m-root", "z-dep");
  db.addDependency("orgA", "m-root", "a-dep");

  const lockOrder: string[] = [];
  const base = db.db;
  const wrapped = {
    ...base,
    $transaction: ((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
      base.$transaction(async (tx) => {
        const raw = (tx as { $queryRaw: (...a: unknown[]) => Promise<unknown> }).$queryRaw;
        (tx as { $queryRaw: unknown }).$queryRaw = async (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => {
          if (String(strings.join("")).includes("CadDocument")) lockOrder.push(values[0] as string);
          return raw(strings, ...values);
        };
        return fn(tx);
      }, opts as never)) as typeof base.$transaction,
  } as typeof base;

  await advanceRevisionForActor(actorIn("orgA"), "rev-1", LifecycleState.RELEASED, wrapped, db.provider);

  assert.deepEqual(lockOrder, ["a-dep", "m-root", "z-dep"], "closure locked in one global ascending-id order");
  assert.equal(db.entries.length, 3);
});

// ============================================================
// B03: approval authority, separation of duties, append-only lifecycle
// events (Product Owner decisions D-A, D-A1..D-A9). Each test asserts both
// the decision AND what was (or was not) written.
// ============================================================

/** A WORKING revision created by `creator-orgA`. */
function seedWorkingRevision(
  db: FakeDatabase,
  overrides: Partial<RevisionRow> = {},
): RevisionRow {
  const row: RevisionRow = {
    organizationId: "orgA",
    id: "rev-w",
    itemId: "item-1",
    lifecycle: LifecycleState.WORKING,
    sourceRevisionId: null,
    releasedAt: null,
    createdById: "creator-orgA",
    ...overrides,
  };
  db.addRevision(row);
  return row;
}

function actorAs(userId: string, role: string): Actor {
  return actorIn("orgA", { userId, role: role as UserRole });
}

async function expectPermissionError(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof LifecyclePermissionError, `expected LifecyclePermissionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function snapshot(db: FakeDatabase) {
  return {
    lifecycles: db.revisions.map((r) => `${r.id}:${r.lifecycle}`),
    events: db.events.length,
    baselines: db.baselines.length,
  };
}

test("B03 full flow: designer creates, engineer submits, approver approves and releases - one event per step, actor + role + time recorded", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "creator-orgA", "DESIGNER");
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db);
  db.addLink("orgA", "rev-w", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);

  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider, {
    comment: "  looks good \u0007 ",
  });
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.RELEASED, db.db, db.provider);

  const events = db.eventsFor("rev-w");
  assert.deepEqual(
    events.map((e) => [e.fromState, e.toState, e.actedById, e.actedByRole, e.trigger]),
    [
      ["WORKING", "IN_REVIEW", "eng", "ENGINEER", "MANUAL"],
      ["IN_REVIEW", "APPROVED", "appr", "APPROVER", "MANUAL"],
      ["APPROVED", "RELEASED", "appr", "APPROVER", "MANUAL"],
    ],
  );
  assert.equal(events[1]!.comment, "looks good", "comment trimmed, control characters stripped");
  assert.equal(events[0]!.comment, null);
  const revision = db.revisions.find((r) => r.id === "rev-w")!;
  assert.equal(revision.lifecycle, LifecycleState.RELEASED);
  assert.equal(
    events[2]!.occurredAt.getTime(),
    revision.releasedAt!.getTime(),
    "release event and releasedAt are the same instant",
  );
  assert.equal(events.every((e) => e.organizationId === "orgA"), true);
  assert.equal(db.baselines.length, 1);
});

test("B03 D-A + D-A9: only APPROVER or ADMIN may approve - ENGINEER, DESIGNER and REVIEWER are refused, nothing written", async () => {
  for (const role of ["ENGINEER", "DESIGNER", "REVIEWER"]) {
    const db = new FakeDatabase();
    db.addUser("orgA", "eng", "ENGINEER");
    db.addUser("orgA", "x", role);
    seedWorkingRevision(db);
    await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
    const before = snapshot(db);
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs("x", role), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
      "ROLE_NOT_PERMITTED",
    );
    assert.deepEqual(snapshot(db), before, `${role}: no state change, no event`);
  }
});

test("B03 D-A: only APPROVER or ADMIN may release - an ENGINEER release is refused, no baseline, no event", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addUser("orgA", "eng", "ENGINEER");
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    "ROLE_NOT_PERMITTED",
  );
  assert.deepEqual(snapshot(db), before);
});

test("B03 D-A + D-A4: the creator cannot approve or release, even as APPROVER or ADMIN", async () => {
  for (const role of ["APPROVER", "ADMIN"]) {
    const db = new FakeDatabase();
    db.addUser("orgA", "creator-orgA", role);
    db.addUser("orgA", "eng", "ENGINEER");
    seedWorkingRevision(db);
    await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
    const before = snapshot(db);
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs("creator-orgA", role), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
      "CREATOR_CANNOT_APPROVE",
    );
    assert.deepEqual(snapshot(db), before, `${role} creator: nothing written`);
  }

  const db = new FakeDatabase();
  seedApprovedRevision(db, { createdById: "admin-creator" });
  db.addUser("orgA", "admin-creator", "ADMIN");
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("admin-creator", "ADMIN"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    "CREATOR_CANNOT_APPROVE",
  );
  assert.deepEqual(snapshot(db), before, "ADMIN creator cannot release (no override)");
});

test("B03 D-A1: anyone who EVER submitted is excluded - A submits, it is returned, B resubmits, A (APPROVER) still cannot approve or release", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "a", "APPROVER");
  db.addUser("orgA", "b", "ENGINEER");
  db.addUser("orgA", "appr2", "APPROVER");
  seedWorkingRevision(db);
  db.addLink("orgA", "rev-w", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);

  await advanceRevisionForActor(actorAs("a", "APPROVER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
  await advanceRevisionForActor(actorAs("b", "ENGINEER"), "rev-w", LifecycleState.WORKING, db.db, db.provider);
  await advanceRevisionForActor(actorAs("b", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);

  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("a", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
    "SUBMITTER_CANNOT_APPROVE",
  );
  assert.deepEqual(snapshot(db), before);

  // A different approver approves; A still may not release.
  await advanceRevisionForActor(actorAs("appr2", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider);
  const beforeRelease = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("a", "APPROVER"), "rev-w", LifecycleState.RELEASED, db.db, db.provider),
    "SUBMITTER_CANNOT_APPROVE",
  );
  assert.deepEqual(snapshot(db), beforeRelease);
});

test("B03 D-A2: a legacy revision with NO recorded creator may be approved by an eligible approver", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db, { createdById: null });
  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider);
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
  assert.equal(db.eventsFor("rev-w").length, 2);
});

// ------------------------------------------------------------
// Codex NO-GO finding 1: the legacy hold cannot be bypassed
// ------------------------------------------------------------

test("B03 finding 1: legacy IN_REVIEW - three return/resubmit cycles never lift the hold; APPROVER and ADMIN approval refused every time; history, creator and hold intact", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "des", "DESIGNER");
  db.addUser("orgA", "appr", "APPROVER");
  db.addUser("orgA", "admin", "ADMIN");
  const rev = seedWorkingRevision(db, { id: "legacy-review", lifecycle: LifecycleState.IN_REVIEW, legacyHold: true });

  for (const [actor, role] of [["appr", "APPROVER"], ["admin", "ADMIN"]] as const) {
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs(actor, role), "legacy-review", LifecycleState.APPROVED, db.db, db.provider),
      "LEGACY_HISTORY_UNVERIFIED",
    );
  }
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await advanceRevisionForActor(actorAs("des", "DESIGNER"), "legacy-review", LifecycleState.WORKING, db.db, db.provider, {
      comment: `revalidation attempt ${cycle}`,
    });
    await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "legacy-review", LifecycleState.IN_REVIEW, db.db, db.provider);
    for (const [actor, role] of [["appr", "APPROVER"], ["admin", "ADMIN"]] as const) {
      const before = snapshot(db);
      await expectPermissionError(
        () => advanceRevisionForActor(actorAs(actor, role), "legacy-review", LifecycleState.APPROVED, db.db, db.provider),
        "LEGACY_HISTORY_UNVERIFIED",
      );
      assert.deepEqual(snapshot(db), before, `cycle ${cycle}, ${role}: nothing written`);
    }
  }
  assert.equal(rev.lifecycle, LifecycleState.IN_REVIEW, "never APPROVED");
  assert.equal(rev.legacyHold, true, "hold still present");
  assert.equal(rev.createdById, "creator-orgA", "creator untouched");
  const history = db.eventsFor("legacy-review");
  assert.equal(history.length, 6, "only the 3 returns + 3 resubmissions were recorded");
  assert.equal(history.every((e) => e.toState !== "APPROVED"), true);
  assert.equal(history.some((e) => e.actedById !== "des" && e.actedById !== "eng"), false, "no fabricated submitter");
});

test("B03 finding 1: legacy APPROVED - release refused (ADMIN); after undo-approval and resubmission, approval is still refused", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "appr", "APPROVER");
  db.addUser("orgA", "appr2", "APPROVER");
  db.addUser("orgA", "admin", "ADMIN");
  seedWorkingRevision(db, { id: "legacy-approved", lifecycle: LifecycleState.APPROVED, legacyHold: true });
  db.addLink("orgA", "legacy-approved", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);

  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("admin", "ADMIN"), "legacy-approved", LifecycleState.RELEASED, db.db, db.provider),
    "LEGACY_HISTORY_UNVERIFIED",
  );
  await advanceRevisionForActor(actorAs("appr2", "APPROVER"), "legacy-approved", LifecycleState.WORKING, db.db, db.provider);
  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "legacy-approved", LifecycleState.IN_REVIEW, db.db, db.provider);
  for (const [actor, role] of [["appr", "APPROVER"], ["admin", "ADMIN"]] as const) {
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs(actor, role), "legacy-approved", LifecycleState.APPROVED, db.db, db.provider),
      "LEGACY_HISTORY_UNVERIFIED",
    );
  }
  assert.equal(db.baselines.length, 0);
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.IN_REVIEW);
});

test("B03 finding 1: a legacy WORKING revision (pre-B03 history unverifiable) may be submitted but never approved; a legacy hold also wins over an unknown creator (D-A2)", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "admin", "ADMIN");
  seedWorkingRevision(db, { id: "legacy-working", legacyHold: true });
  seedWorkingRevision(db, { id: "legacy-nocreator", itemId: "item-2", createdById: null, legacyHold: true });
  for (const id of ["legacy-working", "legacy-nocreator"]) {
    await advanceRevisionForActor(actorAs("eng", "ENGINEER"), id, LifecycleState.IN_REVIEW, db.db, db.provider);
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs("admin", "ADMIN"), id, LifecycleState.APPROVED, db.db, db.provider),
      "LEGACY_HISTORY_UNVERIFIED",
    );
  }
});

test("B03 defense in depth: a NON-legacy revision whose current state was not reached by a recorded event (changed outside the app) is refused STATE_NOT_RECORDED", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db, { id: "oob-review", lifecycle: LifecycleState.IN_REVIEW });
  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("appr", "APPROVER"), "oob-review", LifecycleState.APPROVED, db.db, db.provider),
    "STATE_NOT_RECORDED",
  );
  assert.deepEqual(snapshot(db), before);
});

// ------------------------------------------------------------
// Codex NO-GO finding 3: authoritative database order (`sequence`)
// ------------------------------------------------------------

test("B03 finding 3: REVERSED timestamps - the decision follows sequence: a recorded resubmission (highest sequence, earliest time) allows approval", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db, { id: "rev-r", lifecycle: LifecycleState.IN_REVIEW });
  // sequence order: submit, return, resubmit. Time order is scrambled so that
  // the time-latest event is the RETURN (a time-ordered check would refuse).
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-r", sequence: 11n, fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "s1", occurredAt: seedTime(10) });
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-r", sequence: 12n, fromState: LifecycleState.IN_REVIEW, toState: LifecycleState.WORKING, actedById: "s1", occurredAt: seedTime(30) });
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-r", sequence: 13n, fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "s2", occurredAt: seedTime(20) });

  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-r", LifecycleState.APPROVED, db.db, db.provider);
  const approval = db.eventsFor("rev-r").find((e) => e.toState === "APPROVED")!;
  assert.ok(approval.sequence > 13n, "the new event is ordered after all existing events");
});

test("B03 finding 3: REVERSED timestamps cannot make an unrecorded state look recorded (time-latest = submit, sequence-latest = return)", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db, { id: "rev-x", lifecycle: LifecycleState.IN_REVIEW }); // state changed outside the app
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-x", sequence: 21n, fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "s1", occurredAt: seedTime(50) });
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-x", sequence: 22n, fromState: LifecycleState.IN_REVIEW, toState: LifecycleState.WORKING, actedById: "s1", occurredAt: seedTime(10) });
  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-x", LifecycleState.APPROVED, db.db, db.provider),
    "STATE_NOT_RECORDED",
  );
  assert.deepEqual(snapshot(db), before);
});

test("B03 finding 3: EQUAL timestamps - sequence alone decides (allowed when the highest sequence is the submission, refused when it is the return)", async () => {
  const same = seedTime(5);
  for (const [lastTo, expectAllowed] of [[LifecycleState.IN_REVIEW, true], [LifecycleState.WORKING, false]] as const) {
    const db = new FakeDatabase();
    db.addUser("orgA", "appr", "APPROVER");
    seedWorkingRevision(db, { id: "rev-eq", lifecycle: LifecycleState.IN_REVIEW });
    db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-eq", sequence: 31n, fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "s1", occurredAt: same });
    db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-eq", sequence: 32n, fromState: LifecycleState.IN_REVIEW, toState: LifecycleState.WORKING, actedById: "s1", occurredAt: same });
    db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-eq", sequence: lastTo === LifecycleState.IN_REVIEW ? 33n : 30n, fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "s2", occurredAt: same });
    const run = () => advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-eq", LifecycleState.APPROVED, db.db, db.provider);
    if (expectAllowed) {
      await run();
      assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
    } else {
      await expectPermissionError(run, "STATE_NOT_RECORDED");
    }
  }
});

test("B03 finding 3: every write gets a strictly increasing sequence (full flow + supersession); a rolled-back attempt consumes a value but leaves no row", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db, { id: "rev-source", lifecycle: LifecycleState.RELEASED, releasedAt: new Date() });
  seedApprovedRevision(db, { id: "rev-successor", sourceRevisionId: "rev-source" });
  db.addLink("orgA", "rev-successor", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1, { present: false });
  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-successor", LifecycleState.RELEASED, db.db, db.provider),
    ReleaseBaselineIncompleteError,
  );
  const consumed = db.nextSequence(); // the failed attempt's value is gone, like a PostgreSQL sequence
  db.storageObjects.add("org/orgA/doc/doc-1/v1/fv-1-v1");
  db.storedBytes.set("org/orgA/doc/doc-1/v1/fv-1-v1", { sha256: "checksum-fv-1-v1", size: 100 });
  await advanceRevisionForActor(actorIn("orgA"), "rev-successor", LifecycleState.RELEASED, db.db, db.provider);
  const release = db.eventsFor("rev-successor").at(-1)!;
  const supersession = db.eventsFor("rev-source").at(-1)!;
  assert.equal(release.toState, "RELEASED");
  assert.equal(supersession.toState, "SUPERSEDED");
  assert.ok(release.sequence > consumed && supersession.sequence > release.sequence, "release, then supersession, in sequence order");
  const all = db.events.map((e) => e.sequence);
  assert.equal(new Set(all.map(String)).size, all.length, "sequences are unique");
});

test("B03 D-A5: any write role may return a revision from review; only APPROVER/ADMIN may undo an approval", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "des", "DESIGNER");
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db);
  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
  await advanceRevisionForActor(actorAs("des", "DESIGNER"), "rev-w", LifecycleState.WORKING, db.db, db.provider, {
    comment: "missing drawing",
  });
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.WORKING);
  assert.equal(db.eventsFor("rev-w").at(-1)!.comment, "missing drawing");

  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider);
  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.WORKING, db.db, db.provider),
    "ROLE_NOT_PERMITTED",
  );
  assert.deepEqual(snapshot(db), before, "ENGINEER cannot undo an approval");

  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.WORKING, db.db, db.provider);
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.WORKING);
  assert.equal(db.eventsFor("rev-w").length, 5);
});

test("B03: the role is re-read in the transaction - a request-time APPROVER demoted to ENGINEER is refused; a deactivated user is refused", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db);
  db.addLink("orgA", "rev-1", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);
  db.addUser("orgA", "demoted", "ENGINEER");
  db.addUser("orgA", "gone", "APPROVER", false);
  const before = snapshot(db);

  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("demoted", "APPROVER"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    "ROLE_NOT_PERMITTED",
  );
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("gone", "APPROVER"), "rev-1", LifecycleState.RELEASED, db.db, db.provider),
    "ACTOR_NOT_ACTIVE",
  );
  assert.deepEqual(snapshot(db), before);
});

test("B03: a VIEWER (re-read from the database) cannot make any transition", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "viewer", "VIEWER");
  seedWorkingRevision(db);
  const before = snapshot(db);
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("viewer", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider),
    "ROLE_NOT_PERMITTED",
  );
  assert.deepEqual(snapshot(db), before);
});

test("B03: a successful release records an AUTOMATIC_SUPERSESSION event for the superseded source (actor = releaser)", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db, { id: "rev-source", lifecycle: LifecycleState.RELEASED, releasedAt: new Date() });
  seedApprovedRevision(db, { id: "rev-successor", sourceRevisionId: "rev-source" });
  db.addLink("orgA", "rev-successor", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1);

  await advanceRevisionForActor(actorIn("orgA"), "rev-successor", LifecycleState.RELEASED, db.db, db.provider);

  const sourceEvents = db.eventsFor("rev-source");
  assert.equal(sourceEvents.length, 1);
  assert.deepEqual(
    [sourceEvents[0]!.fromState, sourceEvents[0]!.toState, sourceEvents[0]!.trigger, sourceEvents[0]!.actedById],
    ["RELEASED", "SUPERSEDED", "AUTOMATIC_SUPERSESSION", "user-orgA"],
  );
  const releaseEvent = db.eventsFor("rev-successor").at(-1)!;
  assert.equal(releaseEvent.toState, "RELEASED");
  assert.equal(sourceEvents[0]!.occurredAt.getTime(), releaseEvent.occurredAt.getTime());
});

test("B03: a failed release (missing binary) writes NO event - neither the release nor the supersession", async () => {
  const db = new FakeDatabase();
  seedApprovedRevision(db, { id: "rev-source", lifecycle: LifecycleState.RELEASED, releasedAt: new Date() });
  seedApprovedRevision(db, { id: "rev-successor", sourceRevisionId: "rev-source" });
  db.addLink("orgA", "rev-successor", "doc-1");
  seedDocumentWithVersion(db, "doc-1", "fv-1-v1", 1, { present: false });
  const eventsBefore = db.events.length;

  await assert.rejects(
    () => advanceRevisionForActor(actorIn("orgA"), "rev-successor", LifecycleState.RELEASED, db.db, db.provider),
    ReleaseBaselineIncompleteError,
  );
  assert.equal(db.events.length, eventsBefore, "rollback removed every event this attempt wrote");
  assert.equal(db.revisions.find((r) => r.id === "rev-source")!.lifecycle, LifecycleState.RELEASED);
});

test("B03: concurrent approvals by two eligible approvers - exactly one succeeds and exactly one APPROVED event is written", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  db.addUser("orgA", "appr1", "APPROVER");
  db.addUser("orgA", "appr2", "ADMIN");
  seedWorkingRevision(db);
  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);

  const results = await Promise.allSettled([
    advanceRevisionForActor(actorAs("appr1", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
    advanceRevisionForActor(actorAs("appr2", "ADMIN"), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(db.eventsFor("rev-w").filter((e) => e.toState === "APPROVED").length, 1);
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.APPROVED);
  // Finding 3: the winner's event has the highest sequence, so the
  // sequence-latest event equals the current state.
  const history = db.eventsFor("rev-w");
  const top = history.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  assert.equal(top.toState, "APPROVED");
});

test("B03 finding 3: concurrent approve vs return-to-Working - exactly one wins and the sequence-latest event equals the final state", async () => {
  for (let round = 0; round < 5; round += 1) {
    const db = new FakeDatabase();
    db.addUser("orgA", "eng", "ENGINEER");
    db.addUser("orgA", "des", "DESIGNER");
    db.addUser("orgA", "appr", "APPROVER");
    seedWorkingRevision(db);
    await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
    const pair = [
      advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
      advanceRevisionForActor(actorAs("des", "DESIGNER"), "rev-w", LifecycleState.WORKING, db.db, db.provider),
    ];
    const results = await Promise.allSettled(round % 2 === 0 ? pair : pair.reverse());
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `round ${round}`);
    const history = db.eventsFor("rev-w");
    assert.equal(history.length, 2, `round ${round}: submit + exactly one winner`);
    const top = history.reduce((a, b) => (b.sequence > a.sequence ? b : a));
    assert.equal(top.toState, db.revisions[0]!.lifecycle, `round ${round}`);
  }
});

test("B03: tenant isolation - a revision in another organization is not found and no event is written", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "appr", "APPROVER");
  seedWorkingRevision(db, { organizationId: "orgB", lifecycle: LifecycleState.IN_REVIEW });
  await assert.rejects(
    () => advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-w", LifecycleState.APPROVED, db.db, db.provider),
    /Revision not found/,
  );
  assert.equal(db.events.length, 0);
});

test("B03 D-A7: an over-long comment is refused before the transaction starts; nothing written", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "eng", "ENGINEER");
  seedWorkingRevision(db);
  await assert.rejects(
    () =>
      advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider, {
        comment: "x".repeat(MAX_LIFECYCLE_COMMENT_LENGTH + 1),
      }),
    InvalidLifecycleCommentError,
  );
  assert.equal(db.transactionAttempts, 0);
  assert.equal(db.events.length, 0);
  assert.equal(db.revisions[0]!.lifecycle, LifecycleState.WORKING);
});

// ============================================================
// Option A (Product Owner decisions O-2 and O-4): approving / releasing the
// SUCCESSOR of a revalidated legacy revision.
// Fixture: item-1 has Rev B (pre-B03 RELEASED, the legacy revision's
// source), legacy Rev C (closed OBSOLETE, created by "legacy-creator",
// submitted after B03 by "legacy-sub", revalidated by "reval") and its
// successor Rev D (created by "reval", submitted by "eng").
// ============================================================

function seedSuccessor(db: FakeDatabase, opts: { successorState?: string; legacyCreatorId?: string | null; legacyItemId?: string } = {}) {
  db.addRevision({ organizationId: "orgA", id: "rev-B", itemId: opts.legacyItemId ?? "item-1", lifecycle: LifecycleState.RELEASED, sourceRevisionId: null, releasedAt: new Date(), createdById: "x", legacyHold: true });
  db.addRevision({ organizationId: "orgA", id: "rev-C", itemId: opts.legacyItemId ?? "item-1", lifecycle: LifecycleState.OBSOLETE, sourceRevisionId: "rev-B", releasedAt: null, createdById: opts.legacyCreatorId === undefined ? "legacy-creator" : opts.legacyCreatorId, legacyHold: true });
  // Legacy history after B03: one recorded submission and its return, then the revalidation closure.
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-C", fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "legacy-sub", occurredAt: seedTime(1) });
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-C", fromState: LifecycleState.IN_REVIEW, toState: LifecycleState.WORKING, actedById: "reval", trigger: "LEGACY_REVALIDATION", occurredAt: seedTime(2) });
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-C", fromState: LifecycleState.WORKING, toState: LifecycleState.OBSOLETE, actedById: "reval", trigger: "LEGACY_REVALIDATION", occurredAt: seedTime(2) });
  db.addRevision({ organizationId: "orgA", id: "rev-D", itemId: "item-1", lifecycle: opts.successorState ?? LifecycleState.IN_REVIEW, sourceRevisionId: "rev-C", releasedAt: null, createdById: "reval", revalidatedFrom: { legacyRevisionId: "rev-C", actedById: "reval" } });
  db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-D", fromState: LifecycleState.WORKING, toState: LifecycleState.IN_REVIEW, actedById: "eng", actedByRole: "ENGINEER", occurredAt: seedTime(3) });
  if ((opts.successorState ?? LifecycleState.IN_REVIEW) === LifecycleState.APPROVED) {
    db.addEvent({ organizationId: "orgA", itemRevisionId: "rev-D", fromState: LifecycleState.IN_REVIEW, toState: LifecycleState.APPROVED, actedById: "appr", occurredAt: seedTime(4) });
  }
  for (const [uid, role] of [["legacy-creator", "APPROVER"], ["legacy-sub", "ADMIN"], ["reval", "APPROVER"], ["eng", "ENGINEER"], ["appr", "APPROVER"], ["admin", "ADMIN"]] as const) {
    db.addUser("orgA", uid, role);
  }
}

test("Option A O-2: the legacy creator, a recorded legacy submitter and the revalidating person are each refused approve (LEGACY_LINEAGE_EXCLUDED / creator rule); nothing written", async () => {
  for (const [who, role, code] of [
    ["legacy-creator", "APPROVER", "LEGACY_LINEAGE_EXCLUDED"],
    ["legacy-sub", "ADMIN", "LEGACY_LINEAGE_EXCLUDED"],
    // The revalidating person is also the successor's creator: the existing creator rule reports first.
    ["reval", "APPROVER", "CREATOR_CANNOT_APPROVE"],
  ] as const) {
    const db = new FakeDatabase();
    seedSuccessor(db);
    const before = snapshot(db);
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs(who, role), "rev-D", LifecycleState.APPROVED, db.db, db.provider),
      code,
    );
    assert.deepEqual(snapshot(db), before, who);
  }
});

test("Option A O-2: the revalidating person is excluded by the lineage rule even when they are NOT the successor's creator", async () => {
  const db = new FakeDatabase();
  seedSuccessor(db);
  db.revisions.find((r) => r.id === "rev-D")!.createdById = "someone-else";
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("reval", "APPROVER"), "rev-D", LifecycleState.APPROVED, db.db, db.provider),
    "LEGACY_LINEAGE_EXCLUDED",
  );
});

test("Option A O-2: the same exclusions apply to RELEASE of the successor; a non-excluded eligible approver may approve and release", async () => {
  const db = new FakeDatabase();
  seedSuccessor(db, { successorState: LifecycleState.APPROVED });
  for (const [who, role] of [["legacy-creator", "APPROVER"], ["legacy-sub", "ADMIN"]] as const) {
    await expectPermissionError(
      () => advanceRevisionForActor(actorAs(who, role), "rev-D", LifecycleState.RELEASED, db.db, db.provider),
      "LEGACY_LINEAGE_EXCLUDED",
    );
  }
  await advanceRevisionForActor(actorAs("admin", "ADMIN"), "rev-D", LifecycleState.RELEASED, db.db, db.provider);
  assert.equal(db.revisions.find((r) => r.id === "rev-D")!.lifecycle, LifecycleState.RELEASED);

  const db2 = new FakeDatabase();
  seedSuccessor(db2);
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-D", LifecycleState.APPROVED, db2.db, db2.provider);
  assert.equal(db2.revisions.find((r) => r.id === "rev-D")!.lifecycle, LifecycleState.APPROVED);
});

test("Option A O-2: an unknown (NULL) legacy creator excludes nobody extra; the legacy submitter and revalidator are still excluded", async () => {
  const db = new FakeDatabase();
  seedSuccessor(db, { legacyCreatorId: null });
  await expectPermissionError(
    () => advanceRevisionForActor(actorAs("legacy-sub", "ADMIN"), "rev-D", LifecycleState.APPROVED, db.db, db.provider),
    "LEGACY_LINEAGE_EXCLUDED",
  );
  await advanceRevisionForActor(actorAs("legacy-creator", "APPROVER"), "rev-D", LifecycleState.APPROVED, db.db, db.provider);
});

test("Option A O-2 does not affect ordinary revisions (no revalidation link)", async () => {
  const db = new FakeDatabase();
  db.addUser("orgA", "legacy-sub", "ADMIN");
  db.addUser("orgA", "eng", "ENGINEER");
  seedWorkingRevision(db);
  await advanceRevisionForActor(actorAs("eng", "ENGINEER"), "rev-w", LifecycleState.IN_REVIEW, db.db, db.provider);
  await advanceRevisionForActor(actorAs("legacy-sub", "ADMIN"), "rev-w", LifecycleState.APPROVED, db.db, db.provider);
});

test("Option A O-4: releasing the successor supersedes the legacy revision's RELEASED source (same item, one step) with an AUTOMATIC_SUPERSESSION event", async () => {
  const db = new FakeDatabase();
  seedSuccessor(db, { successorState: LifecycleState.APPROVED });
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-D", LifecycleState.RELEASED, db.db, db.provider);
  assert.equal(db.revisions.find((r) => r.id === "rev-B")!.lifecycle, LifecycleState.SUPERSEDED);
  assert.equal(db.revisions.find((r) => r.id === "rev-C")!.lifecycle, LifecycleState.OBSOLETE, "the closed legacy revision is untouched");
  const sup = db.eventsFor("rev-B").at(-1)!;
  assert.deepEqual([sup.fromState, sup.toState, sup.trigger, sup.actedById], ["RELEASED", "SUPERSEDED", "AUTOMATIC_SUPERSESSION", "appr"]);
  const rel = db.eventsFor("rev-D").at(-1)!;
  assert.equal(rel.toState, "RELEASED");
  assert.ok(sup.sequence > rel.sequence, "supersession sequenced after the release");
  assert.equal(db.baselines.length, 1);
});

test("Option A O-4: no lineage supersession when the legacy source is not RELEASED, is on another item, or the release fails (rollback)", async () => {
  // Source already SUPERSEDED -> nothing changes.
  const a = new FakeDatabase();
  seedSuccessor(a, { successorState: LifecycleState.APPROVED });
  a.revisions.find((r) => r.id === "rev-B")!.lifecycle = LifecycleState.SUPERSEDED;
  const eventsBefore = a.eventsFor("rev-B").length;
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-D", LifecycleState.RELEASED, a.db, a.provider);
  assert.equal(a.eventsFor("rev-B").length, eventsBefore);

  // Legacy revision (and its source) on another item -> not superseded.
  const b = new FakeDatabase();
  seedSuccessor(b, { successorState: LifecycleState.APPROVED, legacyItemId: "item-OTHER" });
  await advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-D", LifecycleState.RELEASED, b.db, b.provider);
  assert.equal(b.revisions.find((r) => r.id === "rev-B")!.lifecycle, LifecycleState.RELEASED);

  // Failed release (missing binary) -> nothing superseded, no events, successor stays APPROVED.
  const c = new FakeDatabase();
  seedSuccessor(c, { successorState: LifecycleState.APPROVED });
  c.addLink("orgA", "rev-D", "doc-1");
  seedDocumentWithVersion(c, "doc-1", "fv-1-v1", 1, { present: false });
  const before = snapshot(c);
  await assert.rejects(
    () => advanceRevisionForActor(actorAs("appr", "APPROVER"), "rev-D", LifecycleState.RELEASED, c.db, c.provider),
    ReleaseBaselineIncompleteError,
  );
  assert.deepEqual(snapshot(c), before);
  assert.equal(c.revisions.find((r) => r.id === "rev-B")!.lifecycle, LifecycleState.RELEASED);
});
