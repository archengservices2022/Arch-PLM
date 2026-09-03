import { LifecycleState } from "@/app/generated/prisma/enums";

// ============================================================
// Arch PLM — engineering revision rules (Milestone 3)
//
// Pure logic shared by the server actions (app/actions.ts) and the
// dashboard Server Component (app/page.tsx). No secrets, no I/O.
//
// LOCKED RULES:
//   - Revisions are single letters A..Z. ItemRevision.revision stays a
//     String in Prisma for future configurability; it is NOT a DB enum.
//   - Lifecycle changes follow an explicit server-enforced transition map.
//   - Manual RELEASED -> SUPERSEDED is never exposed; supersession only
//     happens automatically along source-revision lineage.
// ============================================================

export const REVISION_PATTERN = /^[A-Z]$/;

/** Trim + uppercase, then require exactly one letter A..Z. "a" -> "A". */
export function normalizeRevision(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (!REVISION_PATTERN.test(value)) {
    throw new Error(
      `Revision must be a single letter A–Z. "${raw.trim()}" is not allowed.`,
    );
  }
  return value;
}

/** Server-side source of truth for "Create next revision": A->B ... Y->Z. */
export function nextRevisionLetter(current: string): string {
  const value = current.trim().toUpperCase();
  if (!REVISION_PATTERN.test(value)) {
    throw new Error(`Source revision "${current}" is not a letter A–Z.`);
  }
  if (value === "Z") {
    throw new Error("Revisions beyond Z are not supported yet.");
  }
  return String.fromCharCode(value.charCodeAt(0) + 1);
}

// ------------------------------------------------------------
// Lifecycle state machine
// ------------------------------------------------------------

/** Manually selectable transitions. Terminal states have no outgoing edges. */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  [LifecycleState.WORKING]: [LifecycleState.IN_REVIEW, LifecycleState.OBSOLETE],
  [LifecycleState.IN_REVIEW]: [LifecycleState.WORKING, LifecycleState.APPROVED],
  [LifecycleState.APPROVED]: [LifecycleState.WORKING, LifecycleState.RELEASED],
  [LifecycleState.RELEASED]: [],
  [LifecycleState.SUPERSEDED]: [],
  [LifecycleState.OBSOLETE]: [],
};

export const TERMINAL_LIFECYCLE_STATES: ReadonlySet<LifecycleState> = new Set([
  LifecycleState.RELEASED,
  LifecycleState.SUPERSEDED,
  LifecycleState.OBSOLETE,
]);

export function isTerminalLifecycle(state: LifecycleState): boolean {
  return TERMINAL_LIFECYCLE_STATES.has(state);
}

export function manualTransitionTargets(
  current: LifecycleState,
): LifecycleState[] {
  return LIFECYCLE_TRANSITIONS[current] ?? [];
}

export function isManualTransitionAllowed(
  current: LifecycleState,
  target: LifecycleState,
): boolean {
  return manualTransitionTargets(current).includes(target);
}

// ------------------------------------------------------------
// Source-revision eligibility for "Create next revision"
// ------------------------------------------------------------

/** A successor revision may be created only from these states. */
export const SOURCE_ELIGIBLE_LIFECYCLES: ReadonlySet<LifecycleState> = new Set([
  LifecycleState.APPROVED,
  LifecycleState.RELEASED,
]);

export function canCreateSuccessorFrom(state: LifecycleState): boolean {
  return SOURCE_ELIGIBLE_LIFECYCLES.has(state);
}

// ------------------------------------------------------------
// CAD document carry-forward mode ("Create next revision")
//
// The mode is ALWAYS explicit — it is never inferred from the presence or
// absence of checkbox values.
//   all      -> carry every CadDocument linked to the source revision
//   selected -> carry only the submitted source-linked document ids
//   none     -> carry zero CadDocuments
// ------------------------------------------------------------

export const CARRY_FORWARD_MODES = ["all", "selected", "none"] as const;
export type CarryForwardMode = (typeof CARRY_FORWARD_MODES)[number];

export function isCarryForwardMode(value: string): value is CarryForwardMode {
  return (CARRY_FORWARD_MODES as readonly string[]).includes(value);
}
