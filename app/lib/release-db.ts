/**
 * Arch PDM - Engineering revision lifecycle transitions + frozen release
 * baseline capture (P3D-1, dependency-complete in P3D-3).
 *
 * Deliberately does NOT import "server-only" and takes `db` / `provider` as
 * required parameters, mirroring `checkout-db.ts` / `checkin-db.ts` /
 * `checkout-release-db.ts` exactly, so this module stays loadable by the
 * plain Node test runner with an in-memory fake database. The Server Action
 * surface is `app/actions.ts`'s `advanceRevision`, now a thin wrapper around
 * `advanceRevisionForActor` below - the transition-validation, optimistic
 * update, and automatic-supersession logic here is a VERBATIM port of what
 * `advanceRevision` did before P3D-1 (see git history), so existing
 * lifecycle/supersession behavior is unchanged for every target other than
 * RELEASED.
 *
 * RELEASE BASELINE: when the target is RELEASED and the optimistic
 * conditional update actually applies, this ALSO builds a frozen
 * `ReleaseBaseline` INSIDE THE SAME transaction, before it commits. If
 * baseline construction throws for ANY reason the whole transaction rolls
 * back: the revision does NOT become RELEASED, its predecessor is NOT
 * superseded, and no partial baseline / partial entry set survives - there
 * is no code path where a raw Prisma error, a lock timeout, a missing binary
 * or a torn dependency graph can leave RELEASED-with-no-baseline or a
 * half-written baseline.
 *
 * DEPENDENCY-COMPLETE CLOSURE (P3D-3): the baseline now freezes one entry per
 * CadDocument in the release's COMPLETE known closure -
 *   - every CadDocument DIRECTLY associated with the ItemRevision via
 *     ItemRevisionDocument (`inclusionKind = DIRECT`), AND
 *   - every CadDocument reachable from those through the outgoing
 *     CadDependency graph, `parentDocumentId -> childDocumentId`, recursively
 *     (`inclusionKind = DEPENDENCY`).
 * The graph math (dedup, cycle-safety, DIRECT-wins provenance, node cap,
 * deterministic ordering) lives in `release-closure-core.ts`. Dependencies
 * are read ONLY from the authoritative CadDependency rows - never inferred
 * from filenames, storage paths or file contents. P3D-1 baselines predate
 * this walk and are never re-expanded (see BACKWARD COMPATIBILITY in
 * `released-workspace-db.ts`).
 *
 * EXACT VERSION FREEZE: every closure document is resolved to its current
 * usable FileVersion via the SAME shared resolver Get Latest / Checkout /
 * Check-In use (`file-version-resolution-core.ts`) - never a second "latest"
 * definition, never a fallback to an older binary. That exact FileVersion id
 * is what lands in ReleaseBaselineEntry. Once the baseline row set commits,
 * later FileVersions / CadDependency edits / ItemRevisionDocument edits have
 * ZERO effect on it, and released retrieval never recomputes the closure.
 *
 * STORAGE INTEGRITY (P3D-3, narrowly-scoped change from P3D-1): before a
 * version is frozen, release verifies the pinned object's ACTUAL bytes -
 * `provider.hashObject()` streams it through SHA-256 (never buffering it
 * whole) and both the digest AND the byte size must equal the FileVersion's
 * own `checksum` / `fileSize`. P3D-1 only checked that SOME object existed at
 * the key; a corrupted or silently-replaced object would have passed. This
 * is the SAME primitive and verify-then-trust pattern
 * `readCadFileVersionForActor` (`storage.ts`) and P3D-2 released retrieval
 * already use. Cost: release I/O is now proportional to the total byte size
 * of the frozen package (one streamed read per closure document). This is
 * intentional - release evidence that has silently rotted must not be
 * frozen as if intact.
 *
 * CONCURRENCY (the core design problem): a release must pin a COHERENT set of
 * FileVersions across the WHOLE closure - not resolve them non-transactionally
 * and write the snapshot later, and not observe a dependency graph that is
 * half before-a-mutation and half after.
 *
 *   1. Every closure CadDocument (direct AND dependency) is locked with the
 *      SAME `SELECT ... FOR UPDATE` (`lockCadDocumentForVersionMutation`,
 *      `db-concurrency-db.ts`) that Checkout acquisition, direct FileVersion
 *      upload, and (P3D-3) CadDependency creation already take. Locks are
 *      acquired in a single global lexicographic CadDocument-id order, so an
 *      AB/BA deadlock against any other operation that locks an overlapping
 *      set (another release, a direct upload, a dependency mutation) cannot
 *      occur.
 *   2. The closure is resolved, then locked, then RE-resolved under the
 *      locks; if it grew (an edge was added out of a closure node between the
 *      first read and the lock), the new nodes are locked too and it is
 *      re-resolved again, until stable. Because CadDependency creation now
 *      takes the SAME CadDocument lock on its parent+child, once this
 *      transaction holds every closure-node lock no concurrent edge out of a
 *      closure node can commit - so the loop converges in at most two passes
 *      in practice (a hard pass cap guards an adversarial graph).
 *   3. Both this transaction and every racing mutation
 *      (Check-In, direct upload, dependency creation, another release) run
 *      under Postgres SERIALIZABLE isolation. Even for the one operation that
 *      does NOT take the CadDocument lock (Check-In locks the CadCheckout row
 *      instead), SSI's read-write-dependency tracking still guarantees the
 *      two commits correspond to SOME valid serial order - release-then-X or
 *      X-then-release, never a torn result - aborting one side with a
 *      serialization failure if a genuine anomaly would otherwise occur.
 *      `runSerializableTransaction`'s bounded retry absorbs that abort.
 *
 * RELEASE VS ASSOCIATION MUTATION: `linkExistingCadDocumentToRevision` /
 * createCadDocument lock the ItemRevision row itself (via
 * `lockItemRevisionForCadMutation` in app/actions.ts) before writing an
 * ItemRevisionDocument link, and this module's conditional lifecycle UPDATE
 * takes an equivalent row lock on the SAME ItemRevision row. So by the time
 * this transaction reads ItemRevisionDocument (after its successful
 * conditional update, which holds that row lock for the rest of the
 * transaction) no concurrent association mutation can be in flight.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { CadDependencyType, LifecycleEventTrigger, LifecycleState } from "../generated/prisma/enums.ts";
import {
  isTerminalLifecycle,
  isManualTransitionAllowed,
} from "./revisions.ts";
import {
  evaluateLifecycleTransition,
  normalizeLifecycleComment,
  type LifecycleDenialCode,
  type LifecycleEventFact,
} from "./lifecycle-policy-core.ts";
import { lineageExclusionIds } from "./legacy-revalidation-core.ts";
import { LifecycleStateError } from "./lifecycle-errors-core.ts";
import {
  lockCadDocumentForVersionMutation,
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import {
  DEFAULT_MAX_VERSIONS_SCANNED,
  resolveCurrentFileVersion,
} from "./file-version-resolution-core.ts";
import {
  computeReleaseClosure,
  DEFAULT_MAX_RELEASE_CLOSURE_NODES,
  MAX_CLOSURE_STABILIZATION_PASSES,
  ReleaseClosureInvalidError,
  ReleaseClosureTooLargeError,
  type ReleaseClosureResult,
} from "./release-closure-core.ts";
import {
  ReleaseBaselineIncompleteError,
  type ReleaseBaselineResult,
} from "./release-baseline-core.ts";
import type { StorageProvider } from "./storage-core.ts";
import {
  findStructureGaps,
  ReleaseStructureIncompleteError,
} from "./release-structure-guard-core.ts";

export {
  ReleaseBaselineIncompleteError,
  ReleaseClosureInvalidError,
  ReleaseClosureTooLargeError,
  ReleaseStructureIncompleteError,
};
export type { ReleaseBaselineResult };

/** The slice of PrismaClient this module needs. */
export type ReleaseDb = Pick<
  PrismaClient,
  | "itemRevision"
  | "itemRevisionDocument"
  | "cadDocument"
  | "cadDependency"
  | "fileVersion"
  | "releaseBaseline"
  | "releaseBaselineEntry"
  | "user"
  | "itemRevisionLifecycleEvent"
  | "$transaction"
>;

/**
 * B03: a lifecycle transition refused by the authorization / separation-of-
 * duties policy (`lifecycle-policy-core.ts`), or because the acting user is
 * no longer an active member of the organization. Thrown inside the
 * transaction BEFORE any write, so a refusal changes nothing.
 */
export class LifecyclePermissionError extends Error {
  readonly code: LifecycleDenialCode | "ACTOR_NOT_ACTIVE";
  constructor(code: LifecycleDenialCode | "ACTOR_NOT_ACTIVE", message: string) {
    super(message);
    this.name = "LifecyclePermissionError";
    this.code = code;
  }
}

/** B03 options for `advanceRevisionForActor`. */
export interface AdvanceRevisionOptions {
  /** Optional human comment (D-A7); normalized before the transaction. */
  comment?: unknown;
}

/**
 * Resolve the release closure AND hold a `FOR UPDATE` lock on every
 * CadDocument in it, in one global lexicographic id order, converging on a
 * stable set (see the module doc comment, CONCURRENCY point 2).
 */
async function resolveStableLockedClosure(
  tx: Prisma.TransactionClient,
  organizationId: string,
  itemRevisionId: string,
  maxNodes: number,
): Promise<ReleaseClosureResult> {
  const deps = {
    maxNodes,
    async loadDirectDocumentIds() {
      const links = await tx.itemRevisionDocument.findMany({
        where: { organizationId, itemRevisionId },
        select: { cadDocumentId: true },
      });
      return links.map((l) => l.cadDocumentId);
    },
    async loadChildEdges(parentIds: string[]) {
      if (parentIds.length === 0) return [];
      const rows = await tx.cadDependency.findMany({
        where: { organizationId, parentDocumentId: { in: parentIds } },
        select: { parentDocumentId: true, childDocumentId: true },
      });
      return rows.map((r) => ({
        parentCadDocumentId: r.parentDocumentId,
        childCadDocumentId: r.childDocumentId,
      }));
    },
    async loadExistingDocumentIds(ids: string[]) {
      if (ids.length === 0) return [];
      const rows = await tx.cadDocument.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
  };

  const locked = new Set<string>();
  let closure = await computeReleaseClosure(deps);

  for (let pass = 0; pass < MAX_CLOSURE_STABILIZATION_PASSES; pass += 1) {
    const toLock = closure.cadDocumentIds.filter((id) => !locked.has(id));
    if (toLock.length === 0) {
      // Every id in the current closure is already locked and the last
      // re-scan produced nothing new: the graph is stable under our locks.
      return closure;
    }
    // Acquire the still-missing locks, walking the full closure in global
    // ascending-id order so acquisitions stay in a consistent order across
    // operations. The closure only ever grows (monotonic), so in practice
    // this loop runs once. If a concurrent edge write still manages to
    // interleave and produce a lock-order inversion, Postgres's own
    // deadlock detector aborts one side with a serialization error and
    // `runSerializableTransaction` retries the whole release from a clean
    // snapshot - correctness never depends on getting the order perfect
    // mid-growth.
    for (const id of closure.cadDocumentIds) {
      if (locked.has(id)) continue;
      await lockCadDocumentForVersionMutation(tx, organizationId, id);
      locked.add(id);
    }
    closure = await computeReleaseClosure(deps);
  }

  // The closure never stopped growing under its own locks - only possible
  // for an adversarial/corrupt graph. Fail the release rather than loop.
  throw new ReleaseClosureTooLargeError(maxNodes);
}

/**
 * B06 (pilot rule D-B): refuse the release when any document in the LOCKED
 * closure lacks its required structure (an IAM without a COMPONENT link, an
 * IDW/DWG without a DRAWING_REFERENCE link). Read-only. Runs after
 * `resolveStableLockedClosure` holds FOR UPDATE on every closure document, so
 * no edge whose parent is in the closure can be added or removed until this
 * transaction ends (createCadDependency takes the same lock - P3D-3); the
 * SERIALIZABLE transaction is additional protection.
 *
 * @throws ReleaseStructureIncompleteError (the caller's transaction rolls back).
 */
async function assertClosureStructure(
  tx: Prisma.TransactionClient,
  organizationId: string,
  closure: ReleaseClosureResult,
): Promise<void> {
  const ids = closure.cadDocumentIds;
  if (ids.length === 0) return;
  const documents = await tx.cadDocument.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, documentType: true },
  });
  const edges = await tx.cadDependency.findMany({
    where: {
      organizationId,
      parentDocumentId: { in: ids },
      dependencyType: {
        in: [CadDependencyType.COMPONENT, CadDependencyType.DRAWING_REFERENCE],
      },
    },
    select: { parentDocumentId: true, childDocumentId: true, dependencyType: true },
  });
  const gaps = findStructureGaps(
    documents.map((d) => ({ cadDocumentId: d.id, documentType: d.documentType })),
    edges.map((e) => ({
      parentCadDocumentId: e.parentDocumentId,
      childCadDocumentId: e.childDocumentId,
      dependencyType: e.dependencyType,
    })),
  );
  if (gaps.length > 0) {
    throw new ReleaseStructureIncompleteError(gaps);
  }
}

/**
 * Build the dependency-complete frozen release baseline for `itemRevisionId`
 * INSIDE an already-open transaction.
 *
 * A revision with ZERO ItemRevisionDocument associations still produces a
 * baseline - just with zero entries (not every Item is CAD-backed).
 *
 * @throws ReleaseBaselineIncompleteError if any closure CadDocument (direct
 *   or dependency) has no valid current binary-backed FileVersion, or the
 *   resolved object is missing/unreadable, or its actual bytes fail
 *   checksum/size verification. Never falls back to another FileVersion.
 * @throws ReleaseClosureTooLargeError if the dependency closure exceeds the
 *   node cap.
 * @throws ReleaseClosureInvalidError if a dependency edge in the closure
 *   points at a document not available in the organization.
 */
export async function buildReleaseBaselineInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  itemRevisionId: string,
  actorUserId: string,
  provider: StorageProvider,
  maxClosureNodes: number = DEFAULT_MAX_RELEASE_CLOSURE_NODES,
): Promise<ReleaseBaselineResult> {
  const closure = await resolveStableLockedClosure(
    tx,
    organizationId,
    itemRevisionId,
    maxClosureNodes,
  );

  // B06: cheap structure check first, before any file resolution or hashing.
  await assertClosureStructure(tx, organizationId, closure);

  const entries: Array<{
    cadDocumentId: string;
    fileVersionId: string;
    versionNumber: number;
    inclusionKind: "DIRECT" | "DEPENDENCY";
  }> = [];

  // Deterministic: closure.nodes is cadDocumentId-ascending.
  for (const node of closure.nodes) {
    const resolution = await resolveCurrentFileVersion(node.cadDocumentId, {
      maxVersionsScanned: DEFAULT_MAX_VERSIONS_SCANNED,
      async loadVersionsNewestFirst(id) {
        const rows = await tx.fileVersion.findMany({
          where: { organizationId, cadDocumentId: id },
          orderBy: { versionNumber: "desc" },
          take: DEFAULT_MAX_VERSIONS_SCANNED,
          select: {
            id: true,
            versionNumber: true,
            checksum: true,
            fileSize: true,
            storageKey: true,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          versionNumber: row.versionNumber,
          checksum: row.checksum,
          fileSize: row.fileSize == null ? null : Number(row.fileSize),
          storageKey: row.storageKey,
        }));
      },
      async objectExists(storageKey) {
        return provider.exists(storageKey);
      },
    });

    if (resolution.kind !== "ok") {
      throw new ReleaseBaselineIncompleteError(node.cadDocumentId, resolution.kind);
    }

    // P3D-3 byte-level integrity: the resolver only proved an object EXISTS
    // at the key. Verify its ACTUAL bytes match the immutable metadata -
    // one streamed pass, both digest and size, never buffering the file. A
    // storage failure of any kind folds into `missing-binary`; a real
    // mismatch is `corrupt`. The error never restates the expected/actual
    // digest or size.
    const fv = resolution.row;
    let verified: { sha256: string; size: number };
    try {
      verified = await provider.hashObject(fv.storageKey);
    } catch {
      throw new ReleaseBaselineIncompleteError(node.cadDocumentId, "missing-binary");
    }
    if (verified.sha256 !== fv.checksum || verified.size !== fv.fileSize) {
      throw new ReleaseBaselineIncompleteError(node.cadDocumentId, "corrupt");
    }

    entries.push({
      cadDocumentId: node.cadDocumentId,
      fileVersionId: fv.id,
      versionNumber: fv.versionNumber,
      inclusionKind: node.inclusionKind,
    });
  }

  // Two flat writes rather than one nested create: Prisma's nested-create
  // input for a relation that is itself part of ANOTHER composite FK (here,
  // organizationId is shared by the entry's link to its OWN baseline, to its
  // CadDocument, and to its FileVersion) does not accept the scalar
  // explicitly in that shape. A plain `createMany` has no such restriction.
  const baseline = await tx.releaseBaseline.create({
    data: { organizationId, itemRevisionId, createdById: actorUserId },
    select: { id: true, itemRevisionId: true, createdById: true, createdAt: true },
  });

  if (entries.length > 0) {
    await tx.releaseBaselineEntry.createMany({
      data: entries.map((entry) => ({
        organizationId,
        releaseBaselineId: baseline.id,
        cadDocumentId: entry.cadDocumentId,
        fileVersionId: entry.fileVersionId,
        inclusionKind: entry.inclusionKind,
      })),
    });
  }

  return {
    id: baseline.id,
    itemRevisionId: baseline.itemRevisionId,
    createdById: baseline.createdById,
    createdAt: baseline.createdAt.toISOString(),
    entries,
  };
}

/**
 * Move an ItemRevision to a new lifecycle state - a verbatim port of the
 * pre-P3D-1 `advanceRevision` transaction body (see module doc comment),
 * with these additions:
 *  - P3D-1: when `target === RELEASED` and the conditional update actually
 *    applies, atomically build the frozen release baseline in the SAME
 *    transaction before it commits.
 *  - B03: after the existing existence / terminal / transition-map checks,
 *    and BEFORE any write, the acting user's role and active flag are
 *    re-read from the database, the revision's legacy hold and its recorded
 *    lifecycle history (ordered by the database-assigned `sequence`) are
 *    read, and `evaluateLifecycleTransition` decides whether this actor may
 *    make this transition (approval authority, separation of duties, legacy
 *    hold). Every
 *    successful transition then writes exactly one ItemRevisionLifecycleEvent
 *    (MANUAL), and an applied supersession writes one more for the
 *    superseded source (AUTOMATIC_SUPERSESSION) - all in the same
 *    transaction, so a refusal or any later failure leaves no state change
 *    and no event.
 *
 * @throws Error if the revision does not exist, is already terminal, the
 *   transition is not allowed, or a concurrent update won the race after
 *   the bounded SERIALIZABLE retry is exhausted (exact messages preserved
 *   from the original implementation).
 * @throws LifecyclePermissionError if the policy refuses the transition or
 *   the acting user is no longer active - nothing is written.
 * @throws InvalidLifecycleCommentError if the comment is not text or too long
 *   (checked before the transaction starts).
 * @throws ReleaseBaselineIncompleteError / ReleaseClosureTooLargeError /
 *   ReleaseClosureInvalidError if `target === RELEASED` and the frozen
 *   package cannot be captured - the revision does NOT become RELEASED (the
 *   whole transaction rolls back).
 * @throws ReleaseStructureIncompleteError (B06) if `target === RELEASED` and
 *   an assembly or drawing in the closure has no recorded structure - also
 *   rolled back, nothing written.
 */
export async function advanceRevisionForActor(
  actor: Actor,
  revisionId: string,
  target: LifecycleState,
  db: ReleaseDb,
  provider: StorageProvider,
  options: AdvanceRevisionOptions = {},
): Promise<void> {
  const comment = normalizeLifecycleComment(options.comment);

  try {
    await runSerializableTransaction(db, async (tx) => {
      const current = await tx.itemRevision.findFirst({
        where: { id: revisionId, organizationId: actor.organizationId },
        select: {
          id: true,
          itemId: true,
          lifecycle: true,
          sourceRevisionId: true,
          createdById: true,
          // B03 (NO-GO finding 1): pre-B03 revisions carry an immutable hold.
          legacyLifecycleHold: { select: { itemRevisionId: true } },
          // Option A: present when this revision is the successor of a
          // revalidated legacy revision (drives O-2 and O-4 below).
          legacyRevalidationAsSuccessor: {
            select: {
              actedById: true,
              legacyRevision: {
                select: { id: true, itemId: true, createdById: true, sourceRevisionId: true },
              },
            },
          },
        },
      });

      // Pilot UX fix KI-2: the refusals below carry their unchanged messages
      // plus a stable code (LifecycleStateError), so the dashboard can show
      // a fixed message instead of an error page. Same checks, same order.
      if (!current) {
        throw new LifecycleStateError("REVISION_NOT_FOUND", "Revision not found");
      }

      // Release immutability + existing terminal protection.
      if (isTerminalLifecycle(current.lifecycle)) {
        throw new LifecycleStateError(
          "TERMINAL_REVISION",
          "Released or terminal revisions cannot be changed",
        );
      }

      if (!isManualTransitionAllowed(current.lifecycle, target)) {
        throw new LifecycleStateError(
          "INVALID_TRANSITION",
          `Invalid lifecycle transition: ${current.lifecycle} -> ${target}`,
        );
      }

      // B03: authorization inside the transaction, before any write. The
      // role is re-read here (not trusted from the request-time actor), so a
      // demotion or deactivation that commits first is honored.
      const actingUser = await tx.user.findFirst({
        where: {
          id: actor.userId,
          organizationId: actor.organizationId,
          active: true,
        },
        select: { id: true, role: true },
      });
      if (!actingUser) {
        throw new LifecyclePermissionError(
          "ACTOR_NOT_ACTIVE",
          "Your account is not active in this organization.",
        );
      }

      // Ordered by the database-assigned `sequence` (NO-GO finding 3); the
      // policy itself also orders by `sequence`, never by time.
      const history: LifecycleEventFact[] =
        await tx.itemRevisionLifecycleEvent.findMany({
          where: {
            organizationId: actor.organizationId,
            itemRevisionId: current.id,
          },
          orderBy: { sequence: "asc" },
          select: {
            sequence: true,
            fromState: true,
            toState: true,
            actedById: true,
          },
        });

      // Option A, O-2: for a successor, the legacy creator, every recorded
      // legacy submitter and the revalidating person are also excluded -
      // read in this same transaction.
      const revalidation = current.legacyRevalidationAsSuccessor;
      let lineageExcludedIds: string[] = [];
      if (revalidation) {
        const legacyEvents: LifecycleEventFact[] =
          await tx.itemRevisionLifecycleEvent.findMany({
            where: {
              organizationId: actor.organizationId,
              itemRevisionId: revalidation.legacyRevision.id,
            },
            orderBy: { sequence: "asc" },
            select: { sequence: true, fromState: true, toState: true, actedById: true },
          });
        lineageExcludedIds = lineageExclusionIds({
          legacyCreatorId: revalidation.legacyRevision.createdById,
          legacyEvents,
          revalidatedById: revalidation.actedById,
        });
      }

      const decision = evaluateLifecycleTransition({
        actorId: actingUser.id,
        actorRole: actingUser.role,
        from: current.lifecycle,
        to: target,
        creatorId: current.createdById,
        legacyHold: current.legacyLifecycleHold !== null,
        events: history,
        lineageExcludedIds,
      });
      if (!decision.allowed) {
        throw new LifecyclePermissionError(decision.code, decision.message);
      }

      // One instant for the state change and its event (and releasedAt).
      // Informational only: history order is the database `sequence`
      // assigned at INSERT below (NO-GO finding 3).
      const at = new Date();

      // Optimistic conditional update: only apply if the revision is STILL in
      // the state we validated the transition against.
      const updated = await tx.itemRevision.updateMany({
        where: {
          id: current.id,
          organizationId: actor.organizationId,
          lifecycle: current.lifecycle,
        },
        data:
          target === LifecycleState.RELEASED
            ? { lifecycle: target, releasedAt: at }
            : { lifecycle: target },
      });

      if (updated.count === 0) {
        throw new LifecycleStateError(
          "CONCURRENT_CHANGE",
          "The revision changed while you were updating it. Refresh and try again.",
        );
      }

      await tx.itemRevisionLifecycleEvent.create({
        data: {
          organizationId: actor.organizationId,
          itemRevisionId: current.id,
          fromState: current.lifecycle,
          toState: target,
          trigger: LifecycleEventTrigger.MANUAL,
          actedById: actingUser.id,
          actedByRole: actingUser.role,
          comment,
          occurredAt: at,
        },
      });

      // Automatic supersession along source-revision lineage - runs only
      // because the conditional release above succeeded.
      if (target === LifecycleState.RELEASED && current.sourceRevisionId) {
        const superseded = await tx.itemRevision.updateMany({
          where: {
            id: current.sourceRevisionId,
            organizationId: actor.organizationId,
            itemId: current.itemId, // lineage invariant: same Item
            lifecycle: LifecycleState.RELEASED, // no-op if already SUPERSEDED/other
          },
          data: { lifecycle: LifecycleState.SUPERSEDED },
        });
        // B03: record the supersession only if it actually happened.
        if (superseded.count > 0) {
          await tx.itemRevisionLifecycleEvent.create({
            data: {
              organizationId: actor.organizationId,
              itemRevisionId: current.sourceRevisionId,
              fromState: LifecycleState.RELEASED,
              toState: LifecycleState.SUPERSEDED,
              trigger: LifecycleEventTrigger.AUTOMATIC_SUPERSESSION,
              actedById: actingUser.id,
              actedByRole: actingUser.role,
              comment: null,
              occurredAt: at,
            },
          });
        }
      }

      // Option A, O-4: releasing a successor also supersedes the RELEASED
      // revision its legacy revision was derived from (same Item, one step),
      // exactly as if the legacy revision itself had been released. Same
      // conditional update and event as above; rolls back with the release.
      const legacySourceId = revalidation?.legacyRevision.sourceRevisionId ?? null;
      if (
        target === LifecycleState.RELEASED &&
        revalidation &&
        legacySourceId &&
        revalidation.legacyRevision.itemId === current.itemId &&
        legacySourceId !== current.sourceRevisionId
      ) {
        const lineageSuperseded = await tx.itemRevision.updateMany({
          where: {
            id: legacySourceId,
            organizationId: actor.organizationId,
            itemId: current.itemId, // same Item only
            lifecycle: LifecycleState.RELEASED,
          },
          data: { lifecycle: LifecycleState.SUPERSEDED },
        });
        if (lineageSuperseded.count > 0) {
          await tx.itemRevisionLifecycleEvent.create({
            data: {
              organizationId: actor.organizationId,
              itemRevisionId: legacySourceId,
              fromState: LifecycleState.RELEASED,
              toState: LifecycleState.SUPERSEDED,
              trigger: LifecycleEventTrigger.AUTOMATIC_SUPERSESSION,
              actedById: actingUser.id,
              actedByRole: actingUser.role,
              comment: null,
              occurredAt: at,
            },
          });
        }
      }

      // Frozen release baseline, atomic with the transition above. Any
      // failure here rolls back EVERYTHING in this transaction, including the
      // conditional update and the supersession just above - the revision
      // does not become RELEASED, and the predecessor is not superseded.
      if (target === LifecycleState.RELEASED) {
        await buildReleaseBaselineInTransaction(
          tx,
          actor.organizationId,
          current.id,
          actor.userId,
          provider,
        );
      }
    });
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      // Preserves the exact original message for this failure mode.
      throw new LifecycleStateError(
        "RETRY_EXHAUSTED",
        "Could not update the revision due to concurrent changes, please retry",
      );
    }
    throw error;
  }
}
