/**
 * B03: unit tests for the pure lifecycle authorization / separation-of-
 * duties policy (`app/lib/lifecycle-policy-core.ts`). The release-layer
 * tests in `release-db.test.ts` prove the same rules end to end against the
 * fake database (including that a refusal writes nothing).
 *
 * Run with:  node --experimental-strip-types --test tests/lifecycle-policy-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LifecycleState, UserRole } from "../app/generated/prisma/enums.ts";
import { LIFECYCLE_TRANSITIONS } from "../app/lib/revisions.ts";
import {
  APPROVAL_AUTHORITY_ROLES,
  InvalidLifecycleCommentError,
  LIFECYCLE_WRITE_ROLES,
  MAX_LIFECYCLE_COMMENT_LENGTH,
  evaluateLifecycleTransition,
  isApprovalTransition,
  isCurrentStateRecorded,
  isUndoApprovalTransition,
  latestLifecycleEventWhere,
  normalizeLifecycleComment,
  orderLifecycleEvents,
  submitterIdsOf,
  type LifecycleEventFact,
  type LifecyclePolicyInput,
} from "../app/lib/lifecycle-policy-core.ts";

const S = LifecycleState;
const ALL_ROLES = Object.values(UserRole);

function ev(fromState: LifecycleState, toState: LifecycleState, actedById: string, sequence: number): LifecycleEventFact {
  return { fromState, toState, actedById, sequence: BigInt(sequence) };
}

/** A revision created by "creator", submitted by "submitter" (recorded). */
const SUBMITTED: LifecycleEventFact[] = [ev(S.WORKING, S.IN_REVIEW, "submitter", 1)];
const APPROVED_BY_APPR: LifecycleEventFact[] = [...SUBMITTED, ev(S.IN_REVIEW, S.APPROVED, "appr", 2)];

function input(overrides: Partial<LifecyclePolicyInput>): LifecyclePolicyInput {
  return {
    actorId: "appr",
    actorRole: UserRole.APPROVER,
    from: S.IN_REVIEW,
    to: S.APPROVED,
    creatorId: "creator",
    legacyHold: false,
    events: SUBMITTED,
    ...overrides,
  };
}

function codeOf(decision: ReturnType<typeof evaluateLifecycleTransition>): string | null {
  return decision.allowed ? null : decision.code;
}

test("role lists: write roles are every role except VIEWER (mirrors authz.ts PLM_WRITE_ROLES); approval authority is exactly ADMIN + APPROVER", () => {
  assert.deepEqual(
    [...LIFECYCLE_WRITE_ROLES].sort(),
    ALL_ROLES.filter((r) => r !== UserRole.VIEWER).sort(),
  );
  assert.deepEqual([...APPROVAL_AUTHORITY_ROLES].sort(), [UserRole.ADMIN, UserRole.APPROVER].sort());
});

test("approval transitions are exactly IN_REVIEW->APPROVED and APPROVED->RELEASED; undo approval is exactly APPROVED->WORKING", () => {
  const approval: string[] = [];
  const undo: string[] = [];
  for (const [from, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
    for (const to of targets) {
      if (isApprovalTransition(from as LifecycleState, to)) approval.push(`${from}->${to}`);
      if (isUndoApprovalTransition(from as LifecycleState, to)) undo.push(`${from}->${to}`);
    }
  }
  assert.deepEqual(approval.sort(), ["APPROVED->RELEASED", "IN_REVIEW->APPROVED"]);
  assert.deepEqual(undo, ["APPROVED->WORKING"]);
});

test("D-A + D-A9 role matrix: approve and release are allowed only for ADMIN and APPROVER (all 6 roles x 2 transitions)", () => {
  for (const role of ALL_ROLES) {
    const approve = evaluateLifecycleTransition(input({ actorRole: role }));
    const release = evaluateLifecycleTransition(
      input({ actorRole: role, from: S.APPROVED, to: S.RELEASED, events: APPROVED_BY_APPR }),
    );
    const expected = role === UserRole.ADMIN || role === UserRole.APPROVER;
    assert.equal(approve.allowed, expected, `approve as ${role}`);
    assert.equal(release.allowed, expected, `release as ${role}`);
    if (!expected) {
      assert.equal(codeOf(approve), "ROLE_NOT_PERMITTED");
      assert.equal(codeOf(release), "ROLE_NOT_PERMITTED");
    }
  }
});

test("non-approval transitions keep today's rule: every write role allowed, VIEWER refused - with or without a legacy hold", () => {
  const cases: Array<[LifecycleState, LifecycleState]> = [
    [S.WORKING, S.IN_REVIEW],
    [S.WORKING, S.OBSOLETE],
    [S.IN_REVIEW, S.WORKING],
  ];
  for (const legacyHold of [false, true]) {
    for (const [from, to] of cases) {
      for (const role of ALL_ROLES) {
        const decision = evaluateLifecycleTransition(input({ actorRole: role, from, to, events: [], legacyHold }));
        assert.equal(decision.allowed, role !== UserRole.VIEWER, `${from}->${to} as ${role}, hold=${legacyHold}`);
      }
    }
  }
});

test("D-A5: undo approval (APPROVED->WORKING) only for ADMIN and APPROVER - creator/submitter exclusion does not apply to it", () => {
  for (const role of ALL_ROLES) {
    const decision = evaluateLifecycleTransition(
      input({ actorRole: role, from: S.APPROVED, to: S.WORKING, events: APPROVED_BY_APPR }),
    );
    assert.equal(decision.allowed, role === UserRole.ADMIN || role === UserRole.APPROVER, role);
  }
  const creatorUndo = evaluateLifecycleTransition(
    input({ actorId: "creator", from: S.APPROVED, to: S.WORKING, events: APPROVED_BY_APPR }),
  );
  assert.equal(creatorUndo.allowed, true);
});

test("D-A + D-A4: the creator is refused for approve and release, including ADMIN", () => {
  for (const role of [UserRole.APPROVER, UserRole.ADMIN]) {
    const approve = evaluateLifecycleTransition(input({ actorId: "creator", actorRole: role }));
    const release = evaluateLifecycleTransition(
      input({ actorId: "creator", actorRole: role, from: S.APPROVED, to: S.RELEASED, events: APPROVED_BY_APPR }),
    );
    assert.equal(codeOf(approve), "CREATOR_CANNOT_APPROVE", role);
    assert.equal(codeOf(release), "CREATOR_CANNOT_APPROVE", role);
  }
});

test("D-A1: anyone who EVER submitted is refused, not only the latest submitter", () => {
  const history = [
    ev(S.WORKING, S.IN_REVIEW, "first", 1),
    ev(S.IN_REVIEW, S.WORKING, "x", 2),
    ev(S.WORKING, S.IN_REVIEW, "second", 3),
  ];
  assert.deepEqual([...submitterIdsOf(history)].sort(), ["first", "second"]);
  for (const actorId of ["first", "second"]) {
    assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId, events: history }))), "SUBMITTER_CANNOT_APPROVE", actorId);
  }
  assert.equal(evaluateLifecycleTransition(input({ actorId: "x", events: history })).allowed, true);

  const releaseHistory = [...history, ev(S.IN_REVIEW, S.APPROVED, "appr", 4)];
  const release = evaluateLifecycleTransition(
    input({ actorId: "first", from: S.APPROVED, to: S.RELEASED, events: releaseHistory }),
  );
  assert.equal(codeOf(release), "SUBMITTER_CANNOT_APPROVE");
});

test("D-A2: an unknown (NULL) creator does not by itself block an otherwise eligible approver of a NON-legacy revision", () => {
  assert.equal(evaluateLifecycleTransition(input({ creatorId: null })).allowed, true);
});

test("finding 1: a legacy hold refuses approve AND release for APPROVER and ADMIN, whatever the recorded history (return/resubmit cannot lift it)", () => {
  const revalidated = [
    ev(S.IN_REVIEW, S.WORKING, "eng", 1),
    ev(S.WORKING, S.IN_REVIEW, "eng", 2),
    ev(S.IN_REVIEW, S.WORKING, "eng", 3),
    ev(S.WORKING, S.IN_REVIEW, "eng2", 4),
  ];
  for (const role of [UserRole.APPROVER, UserRole.ADMIN]) {
    for (const creatorId of ["creator", null]) {
      const approve = evaluateLifecycleTransition(input({ actorRole: role, creatorId, legacyHold: true, events: revalidated }));
      assert.equal(codeOf(approve), "LEGACY_HISTORY_UNVERIFIED", `${role} approve, creator=${creatorId}`);
      const release = evaluateLifecycleTransition(
        input({
          actorRole: role,
          creatorId,
          legacyHold: true,
          from: S.APPROVED,
          to: S.RELEASED,
          events: [...revalidated, ev(S.IN_REVIEW, S.APPROVED, "other", 5)],
        }),
      );
      assert.equal(codeOf(release), "LEGACY_HISTORY_UNVERIFIED", `${role} release, creator=${creatorId}`);
    }
  }
  // Same history without a hold is approvable - the hold alone is the reason.
  assert.equal(evaluateLifecycleTransition(input({ events: revalidated })).allowed, true);
});

test("STATE_NOT_RECORDED (defense in depth): approve/release refused when the sequence-latest event does not target the current state", () => {
  assert.equal(codeOf(evaluateLifecycleTransition(input({ events: [] }))), "STATE_NOT_RECORDED");
  assert.equal(
    codeOf(evaluateLifecycleTransition(input({ from: S.APPROVED, to: S.RELEASED, events: SUBMITTED }))),
    "STATE_NOT_RECORDED",
  );
  assert.equal(isCurrentStateRecorded(S.IN_REVIEW, SUBMITTED), true);
  assert.equal(isCurrentStateRecorded(S.APPROVED, APPROVED_BY_APPR), true);
  assert.equal(isCurrentStateRecorded(S.IN_REVIEW, []), false);
});

test("finding 3: ordering is by sequence only - input order and array position are irrelevant", () => {
  const scrambled = [
    ev(S.WORKING, S.IN_REVIEW, "s2", 30),
    ev(S.WORKING, S.IN_REVIEW, "s1", 10),
    ev(S.IN_REVIEW, S.WORKING, "s1", 20),
  ];
  assert.deepEqual(orderLifecycleEvents(scrambled).map((e) => e.sequence), [10n, 20n, 30n]);
  assert.equal(latestLifecycleEventWhere(scrambled)?.sequence, 30n);
  assert.equal(latestLifecycleEventWhere(scrambled, (e) => e.toState === S.WORKING)?.sequence, 20n);
  assert.equal(latestLifecycleEventWhere([], () => true), null);
  assert.equal(isCurrentStateRecorded(S.IN_REVIEW, scrambled), true);
  assert.equal(isCurrentStateRecorded(S.IN_REVIEW, [...scrambled].reverse()), true);
  // By array position the last element is the return (seq 20); by sequence
  // the resubmission (seq 30) is latest - sequence wins.
  const lastByPosition = [ev(S.WORKING, S.IN_REVIEW, "s2", 30), ev(S.IN_REVIEW, S.WORKING, "s1", 20)];
  assert.equal(isCurrentStateRecorded(S.IN_REVIEW, lastByPosition), true);
  // orderLifecycleEvents does not mutate its input.
  assert.deepEqual(scrambled.map((e) => e.sequence), [30n, 10n, 20n]);
});

test("D-A6: the approver may also release", () => {
  const decision = evaluateLifecycleTransition(
    input({ actorId: "appr", from: S.APPROVED, to: S.RELEASED, events: APPROVED_BY_APPR }),
  );
  assert.equal(decision.allowed, true);
});

test("check order: role, then legacy hold, then creator, then submitter, then recorded state", () => {
  assert.equal(
    codeOf(evaluateLifecycleTransition(input({ actorId: "creator", actorRole: UserRole.ENGINEER, legacyHold: true, events: [] }))),
    "ROLE_NOT_PERMITTED",
  );
  assert.equal(
    codeOf(evaluateLifecycleTransition(input({ actorId: "creator", legacyHold: true, events: [] }))),
    "LEGACY_HISTORY_UNVERIFIED",
  );
  assert.equal(
    codeOf(evaluateLifecycleTransition(input({ actorId: "creator", events: [ev(S.WORKING, S.IN_REVIEW, "creator", 1)] }))),
    "CREATOR_CANNOT_APPROVE",
  );
  assert.equal(
    codeOf(evaluateLifecycleTransition(input({
      actorId: "s",
      events: [ev(S.WORKING, S.IN_REVIEW, "s", 1), ev(S.IN_REVIEW, S.WORKING, "s", 2)],
    }))),
    "SUBMITTER_CANNOT_APPROVE",
  );
});

test("D-A7 comment normalization: optional, trimmed, control characters stripped, bounded", () => {
  assert.equal(normalizeLifecycleComment(undefined), null);
  assert.equal(normalizeLifecycleComment(null), null);
  assert.equal(normalizeLifecycleComment("   "), null);
  assert.equal(normalizeLifecycleComment(" ok\u0000\u001F\u007F "), "ok");
  assert.equal(normalizeLifecycleComment("x".repeat(MAX_LIFECYCLE_COMMENT_LENGTH)).length, MAX_LIFECYCLE_COMMENT_LENGTH);
  assert.throws(() => normalizeLifecycleComment("x".repeat(MAX_LIFECYCLE_COMMENT_LENGTH + 1)), InvalidLifecycleCommentError);
  assert.throws(() => normalizeLifecycleComment(42), InvalidLifecycleCommentError);
});

// ------------------------------------------------------------
// Option A, O-2: LEGACY_LINEAGE_EXCLUDED
// ------------------------------------------------------------

test("O-2: a person in lineageExcludedIds is refused approve and release (APPROVER and ADMIN); others are not", () => {
  const excluded = ["legacy-creator", "legacy-sub", "reval"];
  for (const actorId of excluded) {
    for (const role of [UserRole.APPROVER, UserRole.ADMIN]) {
      assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId, actorRole: role, lineageExcludedIds: excluded }))), "LEGACY_LINEAGE_EXCLUDED", `${actorId} approve`);
      assert.equal(
        codeOf(evaluateLifecycleTransition(input({ actorId, actorRole: role, from: S.APPROVED, to: S.RELEASED, events: APPROVED_BY_APPR, lineageExcludedIds: excluded }))),
        "LEGACY_LINEAGE_EXCLUDED",
        `${actorId} release`,
      );
    }
  }
  assert.equal(evaluateLifecycleTransition(input({ actorId: "appr", lineageExcludedIds: excluded })).allowed, true);
  assert.equal(evaluateLifecycleTransition(input({ actorId: "legacy-sub" })).allowed, true, "absent list = no lineage exclusion (ordinary revision)");
});

test("O-2: the lineage exclusion applies only to approve/release, not to submit, return, obsolete or undo-approval", () => {
  const excluded = ["x"];
  for (const [from, to] of [[S.WORKING, S.IN_REVIEW], [S.IN_REVIEW, S.WORKING], [S.WORKING, S.OBSOLETE], [S.APPROVED, S.WORKING]] as const) {
    assert.equal(evaluateLifecycleTransition(input({ actorId: "x", from, to, events: APPROVED_BY_APPR, lineageExcludedIds: excluded })).allowed, true, `${from}->${to}`);
  }
});

test("O-2 check order: role, hold, creator, submitter come first; LEGACY_LINEAGE_EXCLUDED before STATE_NOT_RECORDED", () => {
  assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId: "x", actorRole: UserRole.ENGINEER, lineageExcludedIds: ["x"] }))), "ROLE_NOT_PERMITTED");
  assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId: "x", legacyHold: true, lineageExcludedIds: ["x"] }))), "LEGACY_HISTORY_UNVERIFIED");
  assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId: "creator", lineageExcludedIds: ["creator"] }))), "CREATOR_CANNOT_APPROVE");
  assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId: "submitter", lineageExcludedIds: ["submitter"] }))), "SUBMITTER_CANNOT_APPROVE");
  assert.equal(codeOf(evaluateLifecycleTransition(input({ actorId: "x", events: [], lineageExcludedIds: ["x"] }))), "LEGACY_LINEAGE_EXCLUDED");
});
