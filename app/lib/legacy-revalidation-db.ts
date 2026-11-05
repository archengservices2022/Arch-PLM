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
 *      re-read the acting user (active, role);
 *   2. idempotency: already revalidated -> return that successor, write nothing;
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
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { LifecycleEventTrigger, LifecycleState } from "../generated/prisma/enums.ts";
import { runSerializableTransaction, SerializableTransactionExhaustedError } from "./db-concurrency-db.ts";
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

      // Idempotency (spec section 6): a repeated request reports the
      // existing successor and writes nothing.
      if (legacy.legacyRevalidationAsLegacy) {
        return {
          status: "ALREADY_REVALIDATED" as const,
          legacyRevisionId: legacy.id,
          successorRevisionId: legacy.legacyRevalidationAsLegacy.successorRevision.id,
          successorRevision: legacy.legacyRevalidationAsLegacy.successorRevision.revision,
        };
      }

      const actingUser = await tx.user.findFirst({
        where: { id: actor.userId, organizationId: actor.organizationId, active: true },
        select: { id: true, role: true },
      });
      if (!actingUser) throw new LegacyRevalidationError("ACTOR_NOT_ACTIVE");

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
    // report its successor (idempotent), nothing of ours was written.
    if (isUniqueViolationOn(error, "legacyRevisionId")) {
      const existing = await db.itemRevisionLegacyRevalidation.findFirst({
        where: { legacyRevisionId, organizationId: actor.organizationId },
        select: { legacyRevisionId: true, successorRevision: { select: { id: true, revision: true } } },
      });
      if (existing) {
        return {
          status: "ALREADY_REVALIDATED",
          legacyRevisionId: existing.legacyRevisionId,
          successorRevisionId: existing.successorRevision.id,
          successorRevision: existing.successorRevision.revision,
        };
      }
    }
    // Another revision of the Item took the letter first (spec section 5).
    if (isUniqueViolationOn(error, "revision")) {
      throw new LegacyRevalidationError("REVISION_COLLISION");
    }
    throw error;
  }
}
