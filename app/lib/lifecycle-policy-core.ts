import { LifecycleState, UserRole } from "../generated/prisma/enums.ts";

// ============================================================
// Arch PLM - B03 lifecycle authorization and separation of duties
//
// Pure logic: no I/O, no secrets, loadable by the plain Node test runner.
// `advanceRevisionForActor` (app/lib/release-db.ts) calls
// `evaluateLifecycleTransition` INSIDE its SERIALIZABLE transaction, with the
// actor's role re-read from the database, the revision's legacy-hold flag and
// its recorded lifecycle history, BEFORE anything is written. The dashboard
// (app/page.tsx) calls the same function, and the same ordering helpers, only
// to decide what to show; the server decision is always the one in the
// transaction.
//
// PRODUCT OWNER DECISIONS:
//   D-A   Approve (IN_REVIEW -> APPROVED) and release (APPROVED -> RELEASED)
//         only by APPROVER or ADMIN, and never by the revision's creator or
//         by anyone who submitted it for review.
//   D-A1  "Submitter" = ANYONE who has EVER moved this revision
//         WORKING -> IN_REVIEW (not only the latest submitter).
//   D-A2  An unknown (NULL) creator does not by itself block approval.
//   D-A3 + Codex NO-GO finding 1 (2026-11-05): a revision that existed before
//         B03 carries an immutable legacy hold; its pre-B03 submission history
//         is unverifiable, so approve/release are refused (LEGACY_HISTORY_
//         UNVERIFIED) for as long as the hold exists. Returning to Working and
//         resubmitting does NOT lift it; there is no override. Safe
//         revalidation is a separate, unapproved proposal.
//   D-A4  ADMIN has no override.
//   D-A5  Any write role may return a revision from review
//         (IN_REVIEW -> WORKING); only APPROVER or ADMIN may undo an approval
//         (APPROVED -> WORKING).
//   D-A6  The same eligible person may both approve and release.
//   D-A7  Comments are optional.
//   D-A9  REVIEWER has no approval or release authority.
//
// ORDER (Codex NO-GO finding 3): lifecycle history is ordered ONLY by the
// database-assigned `sequence`. Timestamps are never used for ordering or for
// any decision.
// ============================================================

/**
 * Mirrors `app/lib/authz.ts`'s `PLM_WRITE_ROLES` / `assertCanMutate` (every
 * role except VIEWER), the same way `checkout-db.ts` and
 * `copy-design-lineage-db.ts` mirror it: authz.ts imports "server-only" and
 * cannot be loaded here. Re-applied in the transaction because the role is
 * re-read from the database there.
 */
export const LIFECYCLE_WRITE_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.ENGINEER,
  UserRole.DESIGNER,
  UserRole.REVIEWER,
  UserRole.APPROVER,
];

/** The only roles that may approve, release, or undo an approval. */
export const APPROVAL_AUTHORITY_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.APPROVER,
];

export type LifecycleDenialCode =
  | "ROLE_NOT_PERMITTED"
  | "LEGACY_HISTORY_UNVERIFIED"
  | "CREATOR_CANNOT_APPROVE"
  | "SUBMITTER_CANNOT_APPROVE"
  | "STATE_NOT_RECORDED";

/** The parts of an ItemRevisionLifecycleEvent the policy needs. */
export interface LifecycleEventFact {
  /** Authoritative, database-assigned order (ItemRevisionLifecycleEvent.sequence). */
  sequence: bigint;
  fromState: LifecycleState;
  toState: LifecycleState;
  actedById: string;
}

export interface LifecyclePolicyInput {
  actorId: string;
  /** Read from the database, never from the client. */
  actorRole: UserRole;
  from: LifecycleState;
  to: LifecycleState;
  /** ItemRevision.createdById; NULL for pre-lineage revisions (D-A2). */
  creatorId: string | null;
  /** True when an ItemRevisionLegacyLifecycleHold row exists for the revision. */
  legacyHold: boolean;
  /** Every recorded event for this revision, in any order. */
  events: readonly LifecycleEventFact[];
}

export type LifecyclePolicyDecision =
  | { allowed: true }
  | { allowed: false; code: LifecycleDenialCode; message: string };

export const LIFECYCLE_DENIAL_MESSAGES: Record<LifecycleDenialCode, string> = {
  ROLE_NOT_PERMITTED:
    "Only an Approver or Admin can approve or release a revision, or undo an approval.",
  LEGACY_HISTORY_UNVERIFIED:
    "This revision existed before approval tracking, so who submitted it for review cannot be verified. It cannot be approved or released until a revalidation procedure is approved.",
  CREATOR_CANNOT_APPROVE:
    "You created this revision, so a different Approver or Admin must approve and release it.",
  SUBMITTER_CANNOT_APPROVE:
    "You submitted this revision for review, so a different Approver or Admin must approve and release it.",
  STATE_NOT_RECORDED:
    "This revision's current state was not reached through a recorded transition, so it cannot be approved or released.",
};

/** Approve or release: the transitions D-A restricts. */
export function isApprovalTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return (
    (from === LifecycleState.IN_REVIEW && to === LifecycleState.APPROVED) ||
    (from === LifecycleState.APPROVED && to === LifecycleState.RELEASED)
  );
}

/** Undo an approval (D-A5). */
export function isUndoApprovalTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return from === LifecycleState.APPROVED && to === LifecycleState.WORKING;
}

// ------------------------------------------------------------
// Ordering - the ONLY ordering used by authorization and by the dashboard
// ------------------------------------------------------------

/** A copy of `events` in authoritative order (ascending `sequence`). */
export function orderLifecycleEvents<T extends { sequence: bigint }>(
  events: readonly T[],
): T[] {
  return [...events].sort((a, b) =>
    a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0,
  );
}

/** The most recent event (highest `sequence`) matching `predicate`, or null. */
export function latestLifecycleEventWhere<T extends { sequence: bigint }>(
  events: readonly T[],
  predicate: (event: T) => boolean = () => true,
): T | null {
  let latest: T | null = null;
  for (const event of events) {
    if (predicate(event) && (!latest || event.sequence > latest.sequence)) {
      latest = event;
    }
  }
  return latest;
}

/** Everyone who has ever submitted this revision for review (D-A1). */
export function submitterIdsOf(
  events: readonly LifecycleEventFact[],
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (
      event.fromState === LifecycleState.WORKING &&
      event.toState === LifecycleState.IN_REVIEW
    ) {
      ids.add(event.actedById);
    }
  }
  return ids;
}

/**
 * True when the revision's CURRENT state was entered by a recorded event:
 * the event with the highest `sequence` targets `current`. Defense in depth
 * beside the legacy hold (catches a state changed outside the application).
 */
export function isCurrentStateRecorded(
  current: LifecycleState,
  events: readonly LifecycleEventFact[],
): boolean {
  return latestLifecycleEventWhere(events)?.toState === current;
}

function deny(code: LifecycleDenialCode): LifecyclePolicyDecision {
  return { allowed: false, code, message: LIFECYCLE_DENIAL_MESSAGES[code] };
}

/**
 * Decide whether `actor` may move a revision `from` -> `to`.
 *
 * Only the permission question: the caller has already confirmed the
 * revision exists in the actor's organization, is not terminal, and that
 * `from -> to` is in LIFECYCLE_TRANSITIONS.
 *
 * Check order for approve/release (the first failing check is reported):
 * role, legacy hold, creator, submitter, recorded state.
 */
export function evaluateLifecycleTransition(
  input: LifecyclePolicyInput,
): LifecyclePolicyDecision {
  const { actorId, actorRole, from, to, creatorId, legacyHold, events } = input;

  if (!LIFECYCLE_WRITE_ROLES.includes(actorRole)) {
    return deny("ROLE_NOT_PERMITTED");
  }

  if (isUndoApprovalTransition(from, to)) {
    return APPROVAL_AUTHORITY_ROLES.includes(actorRole)
      ? { allowed: true }
      : deny("ROLE_NOT_PERMITTED");
  }

  if (!isApprovalTransition(from, to)) {
    // Submit, return from review, obsolete: any write role (unchanged). These
    // never lift a legacy hold.
    return { allowed: true };
  }

  if (!APPROVAL_AUTHORITY_ROLES.includes(actorRole)) {
    return deny("ROLE_NOT_PERMITTED");
  }
  if (legacyHold) {
    return deny("LEGACY_HISTORY_UNVERIFIED");
  }
  if (creatorId !== null && creatorId === actorId) {
    return deny("CREATOR_CANNOT_APPROVE");
  }
  if (submitterIdsOf(events).has(actorId)) {
    return deny("SUBMITTER_CANNOT_APPROVE");
  }
  if (!isCurrentStateRecorded(from, events)) {
    return deny("STATE_NOT_RECORDED");
  }
  return { allowed: true };
}

// ------------------------------------------------------------
// Optional comment (D-A7)
// ------------------------------------------------------------

export const MAX_LIFECYCLE_COMMENT_LENGTH = 500;

const ALL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export class InvalidLifecycleCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLifecycleCommentError";
  }
}

/**
 * Normalize an optional lifecycle comment: control characters stripped,
 * trimmed, empty -> null, bounded length. Same rules as the checkout
 * history reason (`checkout-release-core.ts`), shorter limit.
 *
 * @throws InvalidLifecycleCommentError if present but not a string, or too long.
 */
export function normalizeLifecycleComment(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new InvalidLifecycleCommentError("Comment must be text.");
  }
  const cleaned = raw.replace(ALL_CONTROL_CHARS, "").trim();
  if (cleaned.length === 0) {
    return null;
  }
  if (cleaned.length > MAX_LIFECYCLE_COMMENT_LENGTH) {
    throw new InvalidLifecycleCommentError(
      `Comment must be ${MAX_LIFECYCLE_COMMENT_LENGTH} characters or fewer.`,
    );
  }
  return cleaned;
}
