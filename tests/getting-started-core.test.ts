import assert from "node:assert/strict";
import test from "node:test";

import { LifecycleState } from "../app/generated/prisma/enums.ts";
import { allStepsDone, gettingStartedSteps } from "../app/lib/getting-started-core.ts";

function counts(partial: Partial<Record<LifecycleState, number>> = {}): Record<LifecycleState, number> {
  return {
    WORKING: 0,
    IN_REVIEW: 0,
    APPROVED: 0,
    RELEASED: 0,
    SUPERSEDED: 0,
    OBSOLETE: 0,
    ...partial,
  } as Record<LifecycleState, number>;
}

function doneKeys(input: Parameters<typeof gettingStartedSteps>[0]) {
  return gettingStartedSteps(input).filter((s) => s.done).map((s) => s.key);
}

test("getting started: an empty workspace has no step done", () => {
  const steps = gettingStartedSteps({ itemCount: 0, cadDocumentCount: 0, lifecycleCounts: counts() });
  assert.deepEqual(steps.map((s) => s.key), ["item", "cad", "review", "approve"]);
  assert.equal(steps.some((s) => s.done), false);
  assert.equal(allStepsDone(steps), false);
});

test("getting started: item and CAD steps follow their counts", () => {
  assert.deepEqual(doneKeys({ itemCount: 1, cadDocumentCount: 0, lifecycleCounts: counts({ WORKING: 1 }) }), ["item"]);
  assert.deepEqual(doneKeys({ itemCount: 1, cadDocumentCount: 2, lifecycleCounts: counts({ WORKING: 1 }) }), ["item", "cad"]);
});

test("getting started: in review counts as submitted, not approved", () => {
  assert.deepEqual(doneKeys({ itemCount: 1, cadDocumentCount: 1, lifecycleCounts: counts({ IN_REVIEW: 1 }) }), ["item", "cad", "review"]);
});

test("getting started: approved, released or superseded completes review and approve", () => {
  for (const state of ["APPROVED", "RELEASED", "SUPERSEDED"] as const) {
    const steps = gettingStartedSteps({ itemCount: 1, cadDocumentCount: 1, lifecycleCounts: counts({ [state]: 1 }) });
    assert.equal(allStepsDone(steps), true, state);
  }
});

test("getting started: an obsolete-only workspace does not count as reviewed", () => {
  assert.deepEqual(doneKeys({ itemCount: 1, cadDocumentCount: 0, lifecycleCounts: counts({ OBSOLETE: 1 }) }), ["item"]);
});

test("getting started: every step links to an in-page section", () => {
  for (const step of gettingStartedSteps({ itemCount: 0, cadDocumentCount: 0, lifecycleCounts: counts() })) {
    assert.match(step.href, /^#[a-z-]+$/);
  }
});
