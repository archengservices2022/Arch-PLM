/**
 * Focused tests for the PDM CAD Check-In core (P3C-2, provider-agnostic).
 *
 * Run with:  node --experimental-strip-types --test tests/checkin-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CadDocumentNotFoundError,
  CheckInRoleError,
  CheckInVersionRaceError,
  CheckoutOwnershipError,
  NotCheckedOutError,
  StaleBaseError,
} from "../app/lib/checkin-core.ts";

test("check-in domain errors carry the expected shape and never invent extra fields", () => {
  assert.ok(new CadDocumentNotFoundError() instanceof Error);
  assert.ok(new CheckInRoleError() instanceof Error);
  assert.ok(new NotCheckedOutError() instanceof Error);
  assert.ok(new CheckInVersionRaceError() instanceof Error);

  const ownership = new CheckoutOwnershipError({
    checkedOutById: "user-b",
    checkedOutByName: "User B",
    checkedOutByEmail: "b@example.test",
  });
  assert.match(ownership.message, /checked out by another user/);
  assert.equal(ownership.checkedOutById, "user-b");
  assert.equal(ownership.checkedOutByName, "User B");
  assert.equal(ownership.checkedOutByEmail, "b@example.test");

  const stale = new StaleBaseError("fv-old", "fv-new");
  assert.match(stale.message, /changed after checkout began/);
  assert.equal(stale.expectedBaseFileVersionId, "fv-old");
  assert.equal(stale.actualLatestFileVersionId, "fv-new");

  const staleNoCurrent = new StaleBaseError("fv-old", null);
  assert.equal(staleNoCurrent.actualLatestFileVersionId, null);
});
