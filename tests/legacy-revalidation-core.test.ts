/**
 * Option A: unit tests for the pure revalidation rules
 * (`app/lib/legacy-revalidation-core.ts`). Spec: B03-OPTION-A-SPECIFICATION.md
 * sections 2, 3, 5, 8 and the Product Owner decisions O-2, O-3, O-5.
 *
 * Run with:  node --experimental-strip-types --test tests/legacy-revalidation-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LifecycleState, UserRole } from "../app/generated/prisma/enums.ts";
import { LIFECYCLE_TRANSITIONS } from "../app/lib/revisions.ts";
import { InvalidLifecycleCommentError, MAX_LIFECYCLE_COMMENT_LENGTH } from "../app/lib/lifecycle-policy-core.ts";
import {
  CREATE_NEXT_FROM_HELD_MESSAGE,
  LegacyRevalidationError,
  evaluateLegacyRevalidation,
  isHeldNonTerminalSource,
  legacyClosurePath,
  lineageExclusionIds,
  normalizeRevalidationReason,
  resolveCarryForward,
  successorRevisionLetter,
} from "../app/lib/legacy-revalidation-core.ts";

const S = LifecycleState;
const ROLES = Object.values(UserRole);
const STATES = Object.values(LifecycleState);

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof LegacyRevalidationError ? error.code : `other:${String(error)}`;
  }
}

test("O-3 + section 2 eligibility matrix: every role x every state x hold/no hold", () => {
  for (const role of ROLES) {
    for (const lifecycle of STATES) {
      for (const legacyHold of [true, false]) {
        const d = evaluateLegacyRevalidation({ actorRole: role, legacyHold, lifecycle });
        let expected: string | null;
        if (role === UserRole.VIEWER) expected = "ROLE_NOT_PERMITTED";
        else if (!legacyHold) expected = "NOT_LEGACY";
        else if (![S.WORKING, S.IN_REVIEW, S.APPROVED].includes(lifecycle)) expected = "NOT_ELIGIBLE_STATE";
        else if (lifecycle === S.APPROVED && role !== UserRole.APPROVER && role !== UserRole.ADMIN) expected = "ROLE_NOT_PERMITTED";
        else expected = null;
        assert.equal(d.allowed ? null : d.code, expected, `${role} ${lifecycle} hold=${legacyHold}`);
      }
    }
  }
});

test("O-3: any write role may revalidate held WORKING / IN_REVIEW; APPROVED only APPROVER / ADMIN", () => {
  for (const role of [UserRole.ADMIN, UserRole.ENGINEER, UserRole.DESIGNER, UserRole.REVIEWER, UserRole.APPROVER]) {
    assert.equal(evaluateLegacyRevalidation({ actorRole: role, legacyHold: true, lifecycle: S.WORKING }).allowed, true, role);
    assert.equal(evaluateLegacyRevalidation({ actorRole: role, legacyHold: true, lifecycle: S.IN_REVIEW }).allowed, true, role);
  }
  for (const role of [UserRole.ENGINEER, UserRole.DESIGNER, UserRole.REVIEWER]) {
    assert.equal(evaluateLegacyRevalidation({ actorRole: role, legacyHold: true, lifecycle: S.APPROVED }).allowed, false, role);
  }
});

test("section 3 closure path uses only existing transitions and ends OBSOLETE", () => {
  assert.deepEqual(legacyClosurePath(S.WORKING), [{ from: S.WORKING, to: S.OBSOLETE }]);
  assert.deepEqual(legacyClosurePath(S.IN_REVIEW), [{ from: S.IN_REVIEW, to: S.WORKING }, { from: S.WORKING, to: S.OBSOLETE }]);
  assert.deepEqual(legacyClosurePath(S.APPROVED), [{ from: S.APPROVED, to: S.WORKING }, { from: S.WORKING, to: S.OBSOLETE }]);
  for (const state of [S.WORKING, S.IN_REVIEW, S.APPROVED]) {
    for (const step of legacyClosurePath(state)) {
      assert.ok(LIFECYCLE_TRANSITIONS[step.from].includes(step.to), `${step.from}->${step.to} must be an existing transition`);
    }
  }
  for (const state of [S.RELEASED, S.SUPERSEDED, S.OBSOLETE]) {
    assert.equal(codeOf(() => legacyClosurePath(state)), "NOT_ELIGIBLE_STATE");
  }
});

test("section 5 successor letter: highest existing + 1 (not legacy + 1), with gaps, unordered, case/whitespace; Z refused", () => {
  assert.equal(successorRevisionLetter(["A"]), "B");
  assert.equal(successorRevisionLetter(["C", "A", "D"]), "E", "legacy C but D exists -> E");
  assert.equal(successorRevisionLetter(["A", "F"]), "G", "gaps are not filled");
  assert.equal(successorRevisionLetter([" b ", "a"]), "C");
  assert.equal(successorRevisionLetter(["A", "junk", "AA"]), "B", "non-letter values ignored");
  assert.equal(successorRevisionLetter(["Y"]), "Z");
  assert.equal(codeOf(() => successorRevisionLetter(["A", "Z"])), "REVISION_LIMIT");
  assert.match(new LegacyRevalidationError("REVISION_LIMIT").message, /revision Z/);
});

test("O-5 reason: required, normalized, bounded", () => {
  for (const blank of [undefined, null, "", "   ", "\u0000\u001F \u007F"]) {
    assert.equal(codeOf(() => normalizeRevalidationReason(blank)), "REASON_REQUIRED", JSON.stringify(blank));
  }
  assert.equal(normalizeRevalidationReason("  re-enter after audit \u0007 "), "re-enter after audit");
  assert.equal(normalizeRevalidationReason("x".repeat(MAX_LIFECYCLE_COMMENT_LENGTH)).length, MAX_LIFECYCLE_COMMENT_LENGTH);
  assert.throws(() => normalizeRevalidationReason("x".repeat(MAX_LIFECYCLE_COMMENT_LENGTH + 1)), InvalidLifecycleCommentError);
  assert.throws(() => normalizeRevalidationReason(42), InvalidLifecycleCommentError);
});

test("section 8 carry-forward: all / none / selected (must be linked; deduplicated); unknown mode refused", () => {
  const linked = ["d1", "d2", "d2", "d3"];
  assert.deepEqual(resolveCarryForward("all", linked, []), ["d1", "d2", "d3"]);
  assert.deepEqual(resolveCarryForward("none", linked, ["d1"]), []);
  assert.deepEqual(resolveCarryForward("selected", linked, ["d3", " d1 ", "d3", ""]), ["d3", "d1"]);
  assert.deepEqual(resolveCarryForward("selected", linked, []), []);
  assert.equal(codeOf(() => resolveCarryForward("selected", linked, ["d9"])), "CARRY_FORWARD_INVALID");
  assert.equal(codeOf(() => resolveCarryForward("copy", linked, [])), "CARRY_FORWARD_INVALID");
});

test("O-2 lineage exclusion set: legacy creator (if known) + every recorded legacy submitter + revalidating person", () => {
  const events = [
    { sequence: 1n, fromState: S.IN_REVIEW, toState: S.WORKING, actedById: "returner" },
    { sequence: 2n, fromState: S.WORKING, toState: S.IN_REVIEW, actedById: "sub1" },
    { sequence: 3n, fromState: S.IN_REVIEW, toState: S.WORKING, actedById: "returner" },
    { sequence: 4n, fromState: S.WORKING, toState: S.IN_REVIEW, actedById: "sub2" },
  ];
  assert.deepEqual(lineageExclusionIds({ legacyCreatorId: "creator", legacyEvents: events, revalidatedById: "reval" }), ["creator", "reval", "sub1", "sub2"]);
  assert.deepEqual(lineageExclusionIds({ legacyCreatorId: null, legacyEvents: [], revalidatedById: "reval" }), ["reval"]);
  assert.deepEqual(lineageExclusionIds({ legacyCreatorId: "x", legacyEvents: [], revalidatedById: "x" }), ["x"], "deduplicated");
  // A return (IN_REVIEW -> WORKING) is not a submission.
  assert.equal(lineageExclusionIds({ legacyCreatorId: null, legacyEvents: events, revalidatedById: "r" }).includes("returner"), false);
});

test("Create next revision guard: refuses only held NON-terminal sources", () => {
  for (const lifecycle of STATES) {
    assert.equal(isHeldNonTerminalSource({ lifecycle, legacyHold: true }), ![S.RELEASED, S.SUPERSEDED, S.OBSOLETE].includes(lifecycle), lifecycle);
    assert.equal(isHeldNonTerminalSource({ lifecycle, legacyHold: false }), false, lifecycle);
  }
  assert.match(CREATE_NEXT_FROM_HELD_MESSAGE, /Revalidate as new revision/);
});
