/**
 * Arch PLM - Option A: revalidate a held legacy revision (transactional).
 *
 * Specification: B03-OPTION-A-SPECIFICATION.md (sections 2-9 and the Product
 * Owner decisions O-1..O-5 in section 11). Pure rules live in
 * `legacy-revalidation-core.ts`; this module performs them atomically.
 *
 * Like `release-db.ts` it does NOT import "server-only" and takes `db` as a
 * parameter, so the plain Node test runner can drive it with an in-memory
 * fake database. The Server Action surface is `revalidateLegacyRevision` in
 * app/actions.ts.
 *
 * ONE SERIALIZABLE TRANSACTION (bounded retry via runSerializableTransaction):
 *   1. read the legacy revision (organization-scoped) with its hold, its
 *      revalidation row (if any), its document links and the Item's letters;
 *      re-read the acting user (same organization, active, role) - BEFORE
 *      any result is returned, including the idempotent one (PD-G1);
 *   2. idempotency: already revalidated -> the CURRENT database role must be
 *      a write role (the original lifecycle eligibility is NOT re-applied to
 *      the now-OBSOLETE legacy revision); return that successor, write nothing;
 *   3. eligibility + role (O-3); successor letter (highest + 1, refuse at Z)
 *      and carry-forward set are resolved BEFORE any write;
 *   4. close the legacy revision through existing transitions only
 *      (IN_REVIEW/APPROVED -> WORKING -> OBSOLETE), each a conditional update
 *      plus one LEGACY_REVALIDATION event carrying the reason;
 *   5. create the WORKING successor: same Item, trusted creator = actor,
 *      sourceRevisionId = legacy revision, no hold;
 *   6. link the carried-forward CAD documents (link rows only - the SAME
 *      CadDocument rows; nothing is copied);
 *   7. insert the append-only ItemRevisionLegacyRevalidation audit row
 *      (legacyRevisionId and successorRevisionId each UNIQUE).
 * Any failure rolls back every step: either the legacy revision is OBSOLETE
 * with recorded events AND exactly one successor exists linked by one audit
 * row, or nothing changed. The legacy hold, creator, history, document links
 * and release baselines are never modified.
 *
 * CONCURRENT DUPLICATE RECOVERY (PD-G1 / PD-G3): if a concurrent revalidation
 * of the same legacy revision commits first, our insert fails with a unique
 * violation on legacyRevisionId and our transaction rolls back. The existing
 * successor is then reported only from a FRESH, bounded, read-only
 * SERIALIZABLE transaction that re-checks the acting user (same organization,
 * active, current write role) in the same snapshot as the organization-scoped
 * read of the existing row. No row found, or retries exhausted, is the
 * controlled refusal CONCURRENT_CHANGE - never a raw Prisma error.
 */
import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { LifecycleEventTrigger, LifecycleState, type UserRole } from "../generated/prisma/enums.ts";
import { runSerializableTransaction, SerializableTransactionExhaustedError } from "./db-concurrency-db.ts";
import { LIFECYCLE_WRITE_ROLES } from "./lifecycle-policy-core.ts";
import {
  evaluateLegacyRevalidation,
  legacyClosurePath,
  LegacyRevalidationError,
  normalizeRevalidationReason,
  resolveCarryForward,
  successorRevisionLetter,
} from "./legacy-revalidation-core.ts";

export { LegacyRevalidationError };

/** The slice of PrismaClient this module needs. */
export type LegacyRevalidationDb = Pick<
  PrismaClient,
  | "itemRevision"
  | "user"
  | "cadDocument"
  | "itemRevisionDocument"
  | "itemRevisionLifecycleEvent"
  | "itemRevisionLegacyRevalidation"
  | "$transaction"
>;

export interface LegacyRevalidationOptions {
  carryForward: string;
  selectedCadDocumentIds?: readonly string[];
  description?: string | null;
  /** Required reason (O-5). */
  comment?: unknown;
}

export type LegacyRevalidationResult = {
  status: "REVALIDATED" | "ALREADY_REVALIDATED";
  legacyRevisionId: string;
  successorRevisionId: string;
  successorRevision: string;
};

function isUniqueViolationOn(error: unknown, field: string): boolean {
  const e = error as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!e || e.code !== "P2002") return false;
  const target = e.meta?.target;
  // Prisma reports either the constrained field names or the constraint name.
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && new RegExp(`(^|_)${field}(_|$)`).test(target);
}

/**
 * PD-G1: re-read the acting user INSIDE the current transaction - same
 * organization, active - and return the role stored in the database (the
 * supplied `Actor.role` is never consulted).
 *
 * @throws LegacyRevalidationError(ACTOR_NOT_ACTIVE) when the user is missing,
 *   inactive or not in the actor's organization. Nothing is written.
 */
async function requireCurrentActingUser(
  tx: Pick<Prisma.TransactionClient, "user">,
  actor: Actor,
): Promise<{ id: string; role: UserRole }> {
  const actingUser = await tx.user.findFirst({
    where: { id: actor.userId, organizationId: actor.organizationId, active: true },
    select: { id: true, role: true },
  });
  if (!actingUser) throw new LegacyRevalidationError("ACTOR_NOT_ACTIVE");
  return actingUser;
}

/**
 * PD-G1: may this CURRENT database role retrieve an existing revalidation
 * result? Any write role (every role except VIEWER). The original lifecycle
 * eligibility (e.g. APPROVER/ADMIN for an APPROVED legacy revision) is not
 * re-applied: the legacy revision is OBSOLETE now and nothing is written.
 *
 * @throws LegacyRevalidationError(ROLE_NOT_PERMITTED) otherwise (PD-G2: the
 *   existing code and message are used unchanged).
 */
function assertMayRetrieveExistingRevalidation(role: UserRole): void {
  if (!LIFECYCLE_WRITE_ROLES.includes(role)) {
    throw new LegacyRevalidationError("ROLE_NOT_PERMITTED");
  }
}

/**
 * Path B: a concurrent revalidation of the same legacy revision committed
 * first (our transaction rolled back on the unique violation). Report its
 * successor only after re-authorizing the actor in a FRESH SERIALIZABLE
 * snapshot - the aborted attempt's check is stale - and only from an
 * organization-scoped read in that same snapshot. Read-only: writes nothing.
 *
 * @throws LegacyRevalidationError(ACTOR_NOT_ACTIVE | ROLE_NOT_PERMITTED) when
 *   the actor is no longer authorized; (CONCURRENT_CHANGE) when retries are
 *   exhausted or no organization-scoped row is found (PD-G3).
 */
async function recoverConcurrentRevalidation(
  actor: Actor,
  legacyRevisionId: string,
  db: LegacyRevalidationDb,
): Promise<LegacyRevalidationResult> {
  let existing: {
    legacyRevisionId: string;
    successorRevision: { id: string; revision: string };
  } | null;
  try {
    existing = await runSerializableTransaction(db, async (tx) => {
      const actingUser = await requireCurrentActingUser(tx, actor);
      assertMayRetrieveExistingRevalidation(actingUser.role);
      return tx.itemRevisionLegacyRevalidation.findFirst({
        where: { legacyRevisionId, organizationId: actor.organizationId },
        select: { legacyRevisionId: true, successorRevision: { select: { id: true, revision: true } } },
      });
    });
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      throw new LegacyRevalidationError("CONCURRENT_CHANGE");
    }
    throw error;
  }
  // PD-G3: the unique violation named legacyRevisionId but no row of THIS
  // organization exists - a controlled refusal, never the raw Prisma error.
  if (!existing) throw new LegacyRevalidationError("CONCURRENT_CHANGE");
  return {
    status: "ALREADY_REVALIDATED",
    legacyRevisionId: existing.legacyRevisionId,
    successorRevisionId: existing.successorRevision.id,
    successorRevision: existing.successorRevision.revision,
  };
}

/**
 * Revalidate a held legacy revision into a fresh successor revision.
 *
 * @throws LegacyRevalidationError for every refusal (codes in
 *   legacy-revalidation-core.ts); nothing is written.
 * @throws InvalidLifecycleCommentError if the reason is not text or too long.
 */
export async function revalidateLegacyRevisionForActor(
  actor: Actor,
  legacyRevisionId: string,
  options: LegacyRevalidationOptions,
  db: LegacyRevalidationDb,
): Promise<LegacyRevalidationResult> {
  // O-5: refused before the transaction if missing or blank.
  const reason = normalizeRevalidationReason(options.comment);
  const description =
    typeof options.description === "string" && options.description.trim() !== ""
      ? options.description.trim()
      : null;

  try {
    return await runSerializableTransaction(db, async (tx) => {
      const legacy = await tx.itemRevision.findFirst({
        where: { id: legacyRevisionId, organizationId: actor.organizationId },
        select: {
          id: true,
          itemId: true,
          revision: true,
          lifecycle: true,
          description: true,
          legacyLifecycleHold: { select: { itemRevisionId: true } },
          legacyRevalidationAsLegacy: {
            select: { successorRevision: { select: { id: true, revision: true } } },
          },
          documentLinks: { select: { cadDocumentId: true } },
        },
      });
      if (!legacy) throw new LegacyRevalidationError("NOT_FOUND");

      // PD-G1: the acting user is re-read in THIS snapshot before any result
      // is returned - including the idempotent one below.
      const actingUser = await requireCurrentActingUser(tx, actor);

      // Idempotency (spec section 6): a repeated request reports the
      // existing successor and writes nothing - but only to a user whose
      // CURRENT database role is a write role (PD-G1).
      if (legacy.legacyRevalidationAsLegacy) {
        assertMayRetrieveExistingRevalidation(actingUser.role);
        return {
          status: "ALREADY_REVALIDATED" as const,
          legacyRevisionId: legacy.id,
          successorRevisionId: legacy.legacyRevalidationAsLegacy.successorRevision.id,
          successorRevision: legacy.legacyRevalidationAsLegacy.successorRevision.revision,
        };
      }

      const decision = evaluateLegacyRevalidation({
        actorRole: actingUser.role,
        legacyHold: legacy.legacyLifecycleHold !== null,
        lifecycle: legacy.lifecycle,
      });
      if (!decision.allowed) throw new LegacyRevalidationError(decision.code);

      // Resolved before any write: successor letter (refuses at Z) and the
      // carry-forward set (each selected id must be linked to the legacy).
      const itemRevisions = await tx.itemRevision.findMany({
        where: { itemId: legacy.itemId, organizationId: actor.organizationId },
        select: { revision: true },
      });
      const letter = successorRevisionLetter(itemRevisions.map((r) => r.revision));
      const carryForwardIds = resolveCarryForward(
        options.carryForward,
        legacy.documentLinks.map((link) => link.cadDocumentId),
        options.selectedCadDocumentIds ?? [],
      );
      if (carryForwardIds.length > 0) {
        const owned = await tx.cadDocument.findMany({
          where: { id: { in: carryForwardIds }, organizationId: actor.organizationId },
          select: { id: true },
        });
        if (owned.length !== carryForwardIds.length) {
          throw new LegacyRevalidationError("CARRY_FORWARD_INVALID");
        }
      }

      const at = new Date();

      // Close the legacy revision through existing transitions only.
      for (const step of legacyClosurePath(legacy.lifecycle)) {
        const updated = await tx.itemRevision.updateMany({
          where: { id: legacy.id, organizationId: actor.organizationId, lifecycle: step.from },
          data: { lifecycle: step.to },
        });
        if (updated.count === 0) throw new LegacyRevalidationError("CONCURRENT_CHANGE");
        await tx.itemRevisionLifecycleEvent.create({
          data: {
            organizationId: actor.organizationId,
            itemRevisionId: legacy.id,
            fromState: step.from,
            toState: step.to,
            trigger: LifecycleEventTrigger.LEGACY_REVALIDATION,
            actedById: actingUser.id,
            actedByRole: actingUser.role,
            comment: reason,
            occurredAt: at,
          },
        });
      }

      // The fresh successor: trusted creator, lineage to the legacy revision,
      // WORKING, no hold (holds are written only by the B03 migration).
      const successor = await tx.itemRevision.create({
        data: {
          organizationId: actor.organizationId,
          itemId: legacy.itemId,
          revision: letter,
          lifecycle: LifecycleState.WORKING,
          description: description ?? legacy.description,
          createdById: actingUser.id,
          sourceRevisionId: legacy.id,
        },
        select: { id: true, revision: true },
      });

      // Carry forward the SAME logical CAD documents (link rows only).
      if (carryForwardIds.length > 0) {
        await tx.itemRevisionDocument.createMany({
          data: carryForwardIds.map((cadDocumentId) => ({
            organizationId: actor.organizationId,
            itemRevisionId: successor.id,
            cadDocumentId,
            createdById: actingUser.id,
          })),
        });
      }

      // Append-only audit link (O-2 / O-4 / O-5 read it later).
      await tx.itemRevisionLegacyRevalidation.create({
        data: {
          organizationId: actor.organizationId,
          legacyRevisionId: legacy.id,
          successorRevisionId: successor.id,
          actedById: actingUser.id,
          actedByRole: actingUser.role,
          comment: reason,
          occurredAt: at,
        },
      });

      return {
        status: "REVALIDATED" as const,
        legacyRevisionId: legacy.id,
        successorRevisionId: successor.id,
        successorRevision: successor.revision,
      };
    });
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      throw new LegacyRevalidationError("CONCURRENT_CHANGE");
    }
    // A concurrent revalidation of the SAME legacy revision committed first:
    // nothing of ours was written. Report its successor (idempotent) only
    // after a fresh authorization in a new snapshot (Path B, PD-G1/PD-G3).
    if (isUniqueViolationOn(error, "legacyRevisionId")) {
      return recoverConcurrentRevalidation(actor, legacyRevisionId, db);
    }
    // Another revision of the Item took the letter first (spec section 5).
    if (isUniqueViolationOn(error, "revision")) {
      throw new LegacyRevalidationError("REVISION_COLLISION");
    }
    throw error;
  }
}
