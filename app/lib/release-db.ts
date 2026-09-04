/**
 * Arch PDM - Engineering revision lifecycle transitions + frozen release
 * baseline capture (P3D-1).
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
 * RELEASE BASELINE (new in P3D-1): when the target is RELEASED and the
 * optimistic conditional update actually applies, this ALSO builds a frozen
 * `ReleaseBaseline` (+ one `ReleaseBaselineEntry` per DIRECTLY associated
 * CadDocument) INSIDE THE SAME transaction, before it commits. If baseline
 * construction throws for ANY reason, the whole transaction rolls back:
 * the conditional update that already ran is undone, so the revision does
 * NOT become RELEASED, its predecessor is NOT superseded, and no partial
 * baseline row survives - there is no code path where a raw Prisma error,
 * a lock timeout, or a missing binary can leave RELEASED-with-no-baseline
 * or a half-written baseline.
 *
 * CONCURRENCY (P3D-1's core design problem): a release must pin a COHERENT
 * set of FileVersions - not resolve them non-transactionally and write the
 * snapshot later. Every directly associated CadDocument is locked with the
 * SAME `SELECT ... FOR UPDATE` (`lockCadDocumentForVersionMutation`,
 * `app/lib/db-concurrency-db.ts`) that Checkout acquisition and direct
 * FileVersion upload already use as their shared mutex (see those modules'
 * doc comments) - so a release deterministically serializes against BOTH:
 *   - a concurrent direct upload (guarded by `upload-guard-db.ts`, which
 *     locks the SAME CadDocument row before inserting a FileVersion);
 *   - a concurrent checkout acquisition (`checkout-db.ts`, same lock).
 * Check-In does NOT take this same lock (it locks the CadCheckout row
 * instead - see `checkin-db.ts`), so it is not blocked by this lock
 * directly; but because BOTH the release transaction and Check-In's
 * transaction run under Postgres SERIALIZABLE isolation, and the release
 * transaction's FileVersion reads and Check-In's FileVersion write on the
 * SAME CadDocument row form a genuine read-write dependency, Postgres's
 * serializable-snapshot-isolation machinery still guarantees the two
 * commits correspond to SOME valid serial order (release-then-checkin or
 * checkin-then-release) - never a torn/incoherent result - aborting one
 * side with a serialization failure if a genuine anomaly would otherwise
 * occur. `runSerializableTransaction`'s bounded retry (shared with every
 * other P3C/P3D mutation) absorbs that abort transparently.
 *
 * LOCK ORDER (deadlock avoidance): when a revision is associated with
 * MULTIPLE CadDocuments, their ids are sorted (stable string sort) BEFORE
 * acquiring any lock, and locks are then acquired strictly in that order.
 * Two operations that both need to lock an overlapping set of documents
 * (e.g. two concurrent multi-document releases, or a release racing a
 * direct upload that also touches several documents indirectly) always
 * request their locks in the SAME relative order, so a classic AB/BA
 * deadlock cannot occur - the second locker always waits behind the first
 * rather than each waiting on the other.
 *
 * RELEASE VS ASSOCIATION MUTATION: `linkExistingCadDocumentToRevision` /
 * createCadDocument already lock the ItemRevision row itself (via
 * `lockItemRevisionForCadMutation` in app/actions.ts) before writing an
 * ItemRevisionDocument link, and this module's conditional lifecycle UPDATE
 * takes an equivalent row lock on the SAME ItemRevision row. That existing
 * protection is untouched by P3D-1: by the time this transaction reads
 * ItemRevisionDocument rows (after its own successful conditional update,
 * which holds the ItemRevision row lock for the rest of the transaction),
 * no concurrent association mutation can be in flight or start until this
 * transaction commits or rolls back.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { LifecycleState } from "../generated/prisma/enums.ts";
import {
  isTerminalLifecycle,
  isManualTransitionAllowed,
} from "./revisions.ts";
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
  ReleaseBaselineIncompleteError,
  type ReleaseBaselineResult,
} from "./release-baseline-core.ts";
import type { StorageProvider } from "./storage-core.ts";

export { ReleaseBaselineIncompleteError };
export type { ReleaseBaselineResult };

/** The slice of PrismaClient this module needs. */
export type ReleaseDb = Pick<
  PrismaClient,
  | "itemRevision"
  | "itemRevisionDocument"
  | "fileVersion"
  | "releaseBaseline"
  | "releaseBaselineEntry"
  | "$transaction"
>;

/**
 * Build the frozen release baseline for `itemRevisionId` INSIDE an already-
 * open transaction. Locks every directly associated CadDocument (sorted by
 * id, for a deterministic cross-operation lock order) before resolving its
 * current FileVersion via the SAME shared resolver Get Latest / Checkout /
 * Check-In use - never a second "latest" definition.
 *
 * A revision with ZERO ItemRevisionDocument associations still produces a
 * baseline - just with zero entries (P3D-1's explicit design decision: not
 * every Item is CAD-backed, and a revision must not be blocked from
 * releasing purely for lacking CAD documents).
 *
 * @throws ReleaseBaselineIncompleteError if any directly associated
 *   CadDocument has no valid current binary-backed FileVersion (missing
 *   entirely, or the expected newest one's binary is absent from storage).
 *   Never falls back to an older FileVersion.
 */
export async function buildReleaseBaselineInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  itemRevisionId: string,
  actorUserId: string,
  provider: StorageProvider,
): Promise<ReleaseBaselineResult> {
  const links = await tx.itemRevisionDocument.findMany({
    where: { organizationId, itemRevisionId },
    select: { cadDocumentId: true },
  });
  const cadDocumentIds = [...new Set(links.map((l) => l.cadDocumentId))].sort();

  const entries: Array<{ cadDocumentId: string; fileVersionId: string; versionNumber: number }> = [];

  for (const cadDocumentId of cadDocumentIds) {
    // Deterministic lock order avoids AB/BA deadlocks against any other
    // operation (another release, a direct upload, a checkout acquisition)
    // that also locks multiple CadDocuments in sorted order.
    await lockCadDocumentForVersionMutation(tx, organizationId, cadDocumentId);

    const resolution = await resolveCurrentFileVersion(cadDocumentId, {
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
      throw new ReleaseBaselineIncompleteError(cadDocumentId, resolution.kind);
    }

    entries.push({
      cadDocumentId,
      fileVersionId: resolution.row.id,
      versionNumber: resolution.row.versionNumber,
    });
  }

  // Two flat writes rather than one nested `releaseBaseline.create({data:
  // {entries: {create: [...]}}})`: Prisma's nested-create input for a
  // relation that is itself part of ANOTHER composite FK (here,
  // organizationId is shared by the entry's link to its OWN baseline, to
  // its CadDocument, and to its FileVersion) does not accept the scalar
  // explicitly in that shape. A plain `createMany` has no such restriction
  // and is one round trip for however many documents are involved.
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
 * with ONE addition: when `target === RELEASED` and the conditional update
 * actually applies, atomically build the frozen release baseline in the
 * SAME transaction before it commits.
 *
 * @throws Error if the revision does not exist, is already terminal, the
 *   transition is not allowed, or a concurrent update won the race after
 *   the bounded SERIALIZABLE retry is exhausted (exact messages preserved
 *   from the original implementation).
 * @throws ReleaseBaselineIncompleteError if `target === RELEASED` and any
 *   directly associated CadDocument has no valid current FileVersion - the
 *   revision does NOT become RELEASED (the whole transaction rolls back).
 */
export async function advanceRevisionForActor(
  actor: Actor,
  revisionId: string,
  target: LifecycleState,
  db: ReleaseDb,
  provider: StorageProvider,
): Promise<void> {
  try {
    await runSerializableTransaction(db, async (tx) => {
      const current = await tx.itemRevision.findFirst({
        where: { id: revisionId, organizationId: actor.organizationId },
        select: {
          id: true,
          itemId: true,
          lifecycle: true,
          sourceRevisionId: true,
        },
      });

      if (!current) {
        throw new Error("Revision not found");
      }

      // Release immutability + existing terminal protection.
      if (isTerminalLifecycle(current.lifecycle)) {
        throw new Error("Released or terminal revisions cannot be changed");
      }

      if (!isManualTransitionAllowed(current.lifecycle, target)) {
        throw new Error(
          `Invalid lifecycle transition: ${current.lifecycle} -> ${target}`,
        );
      }

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
            ? { lifecycle: target, releasedAt: new Date() }
            : { lifecycle: target },
      });

      if (updated.count === 0) {
        throw new Error(
          "The revision changed while you were updating it. Refresh and try again.",
        );
      }

      // Automatic supersession along source-revision lineage - runs only
      // because the conditional release above succeeded.
      if (target === LifecycleState.RELEASED && current.sourceRevisionId) {
        await tx.itemRevision.updateMany({
          where: {
            id: current.sourceRevisionId,
            organizationId: actor.organizationId,
            itemId: current.itemId, // lineage invariant: same Item
            lifecycle: LifecycleState.RELEASED, // no-op if already SUPERSEDED/other
          },
          data: { lifecycle: LifecycleState.SUPERSEDED },
        });
      }

      // P3D-1: frozen release baseline, atomic with the transition above.
      // Any failure here rolls back EVERYTHING in this transaction,
      // including the conditional update and the supersession just above -
      // the revision does not become RELEASED, and the predecessor is not
      // superseded.
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
      throw new Error(
        "Could not update the revision due to concurrent changes, please retry",
      );
    }
    throw error;
  }
}
