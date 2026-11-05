import { LifecycleState, UserRole } from "../generated/prisma/enums.ts";
import {
  APPROVAL_AUTHORITY_ROLES,
  LIFECYCLE_WRITE_ROLES,
  normalizeLifecycleComment,
  submitterIdsOf,
  type LifecycleEventFact,
} from "./lifecycle-policy-core.ts";
import {
  isCarryForwardMode,
  isTerminalLifecycle,
  REVISION_PATTERN,
  type CarryForwardMode,
} from "./revisions.ts";

// ============================================================
// Arch PLM - Option A: revalidate a held legacy revision (pure rules)
//
// Specification: B03-OPTION-A-SPECIFICATION.md, including the Product Owner
// decisions O-1..O-5 (section 11). No I/O; used by
// `legacy-revalidation-db.ts` (inside its SERIALIZABLE transaction) and by
// the dashboard (display only).
//
// A held legacy revision is never approved or released. Revalidation closes
// it (-> WORKING -> OBSOLETE, recorded) and creates a fresh WORKING successor
// whose own B03 review is the control (O-1). The successor's approve/release
// additionally excludes the legacy creator, every recorded legacy submitter
// and the revalidating person (O-2, enforced by lifecycle-policy-core.ts).
// ============================================================

export type LegacyRevalidationCode =
  | "NOT_FOUND"
  | "NOT_LEGACY"
  | "NOT_ELIGIBLE_STATE"
  | "ROLE_NOT_PERMITTED"
  | "ACTOR_NOT_ACTIVE"
  | "REASON_REQUIRED"
  | "REVISION_LIMIT"
  | "REVISION_COLLISION"
  | "CARRY_FORWARD_INVALID"
  | "CONCURRENT_CHANGE";

export const LEGACY_REVALIDATION_MESSAGES: Record<LegacyRevalidationCode, string> = {
  NOT_FOUND: "Revision not found",
  NOT_LEGACY:
    "Only a legacy revision held from approval can be revalidated. Use the normal lifecycle actions for this revision.",
  NOT_ELIGIBLE_STATE:
    "Only a legacy revision in Working, In Review or Approved can be revalidated.",
  ROLE_NOT_PERMITTED:
    "You do not have permission to revalidate this revision. Revalidating an Approved legacy revision requires an Approver or Admin.",
  ACTOR_NOT_ACTIVE: "Your account is not active in this organization.",
  REASON_REQUIRED: "A reason is required to revalidate a legacy revision.",
  REVISION_LIMIT:
    "This item has reached revision Z; revalidation needs revisions beyond Z (F24).",
  REVISION_COLLISION:
    "Another revision was created for this item at the same time. Refresh and retry.",
  CARRY_FORWARD_INVALID:
    "A selected CAD document is not linked to the legacy revision or is not in your organization.",
  CONCURRENT_CHANGE:
    "The revision changed while you were updating it. Refresh and try again.",
};

export class LegacyRevalidationError extends Error {
  readonly code: LegacyRevalidationCode;
  constructor(code: LegacyRevalidationCode, message: string = LEGACY_REVALIDATION_MESSAGES[code]) {
    super(message);
    this.name = "LegacyRevalidationError";
    this.code = code;
  }
}

/** Legacy states that can be revalidated (spec section 2). */
export const REVALIDATION_ELIGIBLE_STATES: readonly LifecycleState[] = [
  LifecycleState.WORKING,
  LifecycleState.IN_REVIEW,
  LifecycleState.APPROVED,
];

export type LegacyRevalidationDecision =
  | { allowed: true }
  | { allowed: false; code: LegacyRevalidationCode; message: string };

function refuse(code: LegacyRevalidationCode): LegacyRevalidationDecision {
  return { allowed: false, code, message: LEGACY_REVALIDATION_MESSAGES[code] };
}

/**
 * May `actorRole` revalidate a revision with this hold flag and lifecycle?
 * - any write role for a held WORKING or IN_REVIEW revision (O-3);
 * - APPROVER or ADMIN only for a held APPROVED revision (closing it is an
 *   undo-approval, D-A5);
 * - never a revision without a legacy hold, or a terminal one.
 * The role must be the one re-read from the database.
 */
export function evaluateLegacyRevalidation(input: {
  actorRole: UserRole;
  legacyHold: boolean;
  lifecycle: LifecycleState;
}): LegacyRevalidationDecision {
  const { actorRole, legacyHold, lifecycle } = input;
  if (!LIFECYCLE_WRITE_ROLES.includes(actorRole)) return refuse("ROLE_NOT_PERMITTED");
  if (!legacyHold) return refuse("NOT_LEGACY");
  if (!REVALIDATION_ELIGIBLE_STATES.includes(lifecycle)) return refuse("NOT_ELIGIBLE_STATE");
  if (lifecycle === LifecycleState.APPROVED && !APPROVAL_AUTHORITY_ROLES.includes(actorRole)) {
    return refuse("ROLE_NOT_PERMITTED");
  }
  return { allowed: true };
}

/**
 * The closure transitions for a legacy revision (spec section 3, step 3),
 * using only transitions that exist in LIFECYCLE_TRANSITIONS.
 */
export function legacyClosurePath(
  lifecycle: LifecycleState,
): Array<{ from: LifecycleState; to: LifecycleState }> {
  switch (lifecycle) {
    case LifecycleState.WORKING:
      return [{ from: LifecycleState.WORKING, to: LifecycleState.OBSOLETE }];
    case LifecycleState.IN_REVIEW:
      return [
        { from: LifecycleState.IN_REVIEW, to: LifecycleState.WORKING },
        { from: LifecycleState.WORKING, to: LifecycleState.OBSOLETE },
      ];
    case LifecycleState.APPROVED:
      return [
        { from: LifecycleState.APPROVED, to: LifecycleState.WORKING },
        { from: LifecycleState.WORKING, to: LifecycleState.OBSOLETE },
      ];
    default:
      throw new LegacyRevalidationError("NOT_ELIGIBLE_STATE");
  }
}

/**
 * The successor's letter: the one after the HIGHEST existing revision letter
 * of the Item (spec section 5), not "legacy + 1". Refuses at Z.
 */
export function successorRevisionLetter(existingRevisions: readonly string[]): string {
  let highest: string | null = null;
  for (const raw of existingRevisions) {
    const value = raw.trim().toUpperCase();
    if (REVISION_PATTERN.test(value) && (highest === null || value > highest)) {
      highest = value;
    }
  }
  if (highest === null) return "A";
  if (highest === "Z") throw new LegacyRevalidationError("REVISION_LIMIT");
  return String.fromCharCode(highest.charCodeAt(0) + 1);
}

/**
 * O-5: the reason is required. Same normalization as lifecycle comments
 * (control characters stripped, trimmed, at most 500 characters).
 *
 * @throws LegacyRevalidationError(REASON_REQUIRED) when missing or blank.
 * @throws InvalidLifecycleCommentError when not text or too long.
 */
export function normalizeRevalidationReason(raw: unknown): string {
  const reason = normalizeLifecycleComment(raw);
  if (reason === null) throw new LegacyRevalidationError("REASON_REQUIRED");
  return reason;
}

/**
 * The CAD documents to link to the successor (spec section 8), exactly like
 * "Create next revision": "all" = every document linked to the legacy
 * revision, "none" = nothing, "selected" = the given ids, each of which must
 * be linked to the legacy revision. Duplicates are removed.
 */
export function resolveCarryForward(
  mode: string,
  legacyDocumentIds: readonly string[],
  selectedIds: readonly string[],
): string[] {
  if (!isCarryForwardMode(mode)) {
    throw new LegacyRevalidationError("CARRY_FORWARD_INVALID", `Unknown carry-forward mode: "${mode}"`);
  }
  const typed: CarryForwardMode = mode;
  if (typed === "none") return [];
  if (typed === "all") return [...new Set(legacyDocumentIds)];
  const linked = new Set(legacyDocumentIds);
  const chosen = [...new Set(selectedIds.map((id) => id.trim()).filter((id) => id !== ""))];
  for (const id of chosen) {
    if (!linked.has(id)) throw new LegacyRevalidationError("CARRY_FORWARD_INVALID");
  }
  return chosen;
}

/**
 * O-2: who may not approve or release the successor besides its own creator
 * and submitters - the legacy revision's creator (if known), everyone
 * recorded as submitting the legacy revision (WORKING -> IN_REVIEW events),
 * and the person who ran the revalidation.
 */
export function lineageExclusionIds(input: {
  legacyCreatorId: string | null;
  legacyEvents: readonly LifecycleEventFact[];
  revalidatedById: string;
}): string[] {
  const ids = new Set<string>(submitterIdsOf(input.legacyEvents));
  if (input.legacyCreatorId) ids.add(input.legacyCreatorId);
  ids.add(input.revalidatedById);
  return [...ids].sort();
}

// ------------------------------------------------------------
// "Create next revision" guard (delegated decision, 2026-11-05)
// ------------------------------------------------------------

export const CREATE_NEXT_FROM_HELD_MESSAGE =
  "This is a legacy revision held from approval. Use \"Revalidate as new revision\" instead of \"Create next revision\".";

/**
 * True when "Create next revision" must refuse this source: it carries a
 * legacy hold and is not terminal (in practice a held APPROVED revision).
 * Otherwise that path would create a successor without the legacy closure,
 * the O-2 exclusions and the O-5 reason. Held RELEASED / SUPERSEDED /
 * OBSOLETE sources are unaffected.
 */
export function isHeldNonTerminalSource(input: {
  lifecycle: LifecycleState;
  legacyHold: boolean;
}): boolean {
  return input.legacyHold && !isTerminalLifecycle(input.lifecycle);
}
