/**
 * Focused tests for the PDM CAD Checkout core (P3C-1, provider-agnostic).
 *
 * Run with:  node --experimental-strip-types --test tests/checkout-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CadDocumentNotFoundError,
  CheckoutConflictError,
  CheckoutRoleError,
  NoValidFileVersionError,
  resolveLatestBinaryVersionForCheckout,
  type CheckoutRecord,
  type CheckoutVersionRow,
} from "../app/lib/checkout-core.ts";

function makeVersionRow(overrides: Partial<CheckoutVersionRow> = {}): CheckoutVersionRow {
  return {
    id: "fv-1",
    versionNumber: 1,
    checksum: "c-1",
    fileSize: 1000,
    storageKey: "org/o/doc/d/v1/aaaa",
    ...overrides,
  };
}

function depsFrom(
  rows: CheckoutVersionRow[],
  presentStorageKeys: Set<string>,
) {
  return {
    async loadVersionsNewestFirst() {
      return [...rows].sort((a, b) => b.versionNumber - a.versionNumber);
    },
    async objectExists(storageKey: string) {
      return presentStorageKeys.has(storageKey);
    },
  };
}

test("resolves the newest binary-backed version when its object is present", async () => {
  const v1 = makeVersionRow({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const v2 = makeVersionRow({ id: "fv-2", versionNumber: 2, storageKey: "key-2" });
  const resolution = await resolveLatestBinaryVersionForCheckout(
    "doc-a",
    depsFrom([v1, v2], new Set(["key-1", "key-2"])),
  );
  assert.equal(resolution.kind, "ok");
  assert.equal((resolution as { row: CheckoutVersionRow }).row.id, "fv-2");
});

test("no FileVersion rows at all -> missing-version", async () => {
  const resolution = await resolveLatestBinaryVersionForCheckout(
    "doc-a",
    depsFrom([], new Set()),
  );
  assert.equal(resolution.kind, "missing-version");
});

test("only metadata-incomplete rows (no checksum/size) -> missing-version, not a crash", async () => {
  const incomplete = makeVersionRow({ checksum: null, fileSize: null });
  const resolution = await resolveLatestBinaryVersionForCheckout(
    "doc-a",
    depsFrom([incomplete], new Set()),
  );
  assert.equal(resolution.kind, "missing-version");
});

test("latest version is metadata-complete but its object is missing -> missing-binary, handled safely", async () => {
  const v1 = makeVersionRow({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const resolution = await resolveLatestBinaryVersionForCheckout(
    "doc-a",
    depsFrom([v1], new Set()), // key-1 not present
  );
  assert.equal(resolution.kind, "missing-binary");
  assert.equal((resolution as { row: CheckoutVersionRow }).row.id, "fv-1");
});

test("no fallback to an older, still-present binary when the newest one is missing", async () => {
  const older = makeVersionRow({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const newer = makeVersionRow({ id: "fv-2", versionNumber: 2, storageKey: "key-2" });
  // Only the OLDER object actually exists in storage.
  const resolution = await resolveLatestBinaryVersionForCheckout(
    "doc-a",
    depsFrom([older, newer], new Set(["key-1"])),
  );
  assert.equal(resolution.kind, "missing-binary");
  assert.equal(
    (resolution as { row: CheckoutVersionRow }).row.id,
    "fv-2",
    "must report the problem against the NEWEST version, never silently substitute the older one",
  );
});

test("a newer metadata-incomplete row is skipped in favor of an older complete + present one", async () => {
  const complete = makeVersionRow({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const incomplete = makeVersionRow({
    id: "fv-2",
    versionNumber: 2,
    checksum: null,
    fileSize: null,
    storageKey: "key-2",
  });
  const resolution = await resolveLatestBinaryVersionForCheckout(
    "doc-a",
    depsFrom([complete, incomplete], new Set(["key-1", "key-2"])),
  );
  assert.equal(resolution.kind, "ok");
  assert.equal((resolution as { row: CheckoutVersionRow }).row.id, "fv-1");
});

test("checkout domain errors carry the expected shape and never invent extra fields", () => {
  assert.ok(new CadDocumentNotFoundError() instanceof Error);
  assert.ok(new CheckoutRoleError() instanceof Error);
  assert.ok(new NoValidFileVersionError() instanceof Error);

  const record: CheckoutRecord = {
    id: "co-1",
    cadDocumentId: "doc-a",
    baseFileVersionId: "fv-1",
    baseVersionNumber: 1,
    checkedOutById: "user-b",
    checkedOutByName: "User B",
    checkedOutByEmail: "b@example.test",
    checkedOutAt: new Date().toISOString(),
    note: null,
  };
  const conflict = new CheckoutConflictError(record);
  assert.equal(conflict.checkout, record);
  assert.match(conflict.message, /already checked out/);
});
