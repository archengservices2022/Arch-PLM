/**
 * Focused tests for the SHARED "current usable FileVersion" resolver
 * (`app/lib/file-version-resolution-core.ts`, P3C-2 Codex MEDIUM follow-up).
 *
 * This is the ONE algorithm Get Latest (`get-latest-core.ts`), Checkout
 * (`checkout-core.ts`) and Check-In's stale-base check (`checkin-db.ts`) all
 * now call - see `tests/get-latest-core.test.ts`, `tests/checkout-core.test.ts`
 * and `tests/checkin-db.test.ts` for the SAME scenarios proven against each
 * of those call sites, confirming they behave identically for identical
 * document states (not just that this module's own logic is correct).
 *
 * Run with:  node --experimental-strip-types --test tests/file-version-resolution-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBinaryBackedFileVersion,
  resolveCurrentFileVersion,
  type FileVersionResolutionRow,
} from "../app/lib/file-version-resolution-core.ts";

function row(overrides: Partial<FileVersionResolutionRow> = {}): FileVersionResolutionRow {
  return {
    id: "fv-1",
    versionNumber: 1,
    checksum: "c-1",
    fileSize: 1000,
    storageKey: "org/o/doc/d/v1/aaaa",
    ...overrides,
  };
}

function depsFrom(rows: FileVersionResolutionRow[], presentStorageKeys: Set<string>) {
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
  const v1 = row({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const v2 = row({ id: "fv-2", versionNumber: 2, storageKey: "key-2" });
  const resolution = await resolveCurrentFileVersion("doc-a", depsFrom([v1, v2], new Set(["key-1", "key-2"])));
  assert.equal(resolution.kind, "ok");
  assert.equal((resolution as { row: FileVersionResolutionRow }).row.id, "fv-2");
});

test("no FileVersion rows at all -> missing-version", async () => {
  const resolution = await resolveCurrentFileVersion("doc-a", depsFrom([], new Set()));
  assert.equal(resolution.kind, "missing-version");
});

test("only metadata-incomplete rows (no checksum/size) -> missing-version, not a crash", async () => {
  const incomplete = row({ checksum: null, fileSize: null });
  const resolution = await resolveCurrentFileVersion("doc-a", depsFrom([incomplete], new Set()));
  assert.equal(resolution.kind, "missing-version");
});

test("latest version is metadata-complete but its object is missing -> missing-binary, handled safely", async () => {
  const v1 = row({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const resolution = await resolveCurrentFileVersion("doc-a", depsFrom([v1], new Set()));
  assert.equal(resolution.kind, "missing-binary");
  assert.equal((resolution as { row: FileVersionResolutionRow }).row.id, "fv-1");
});

test("no fallback to an older, still-present binary when the newest one is missing", async () => {
  const older = row({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const newer = row({ id: "fv-2", versionNumber: 2, storageKey: "key-2" });
  // Only the OLDER object actually exists in storage.
  const resolution = await resolveCurrentFileVersion("doc-a", depsFrom([older, newer], new Set(["key-1"])));
  assert.equal(resolution.kind, "missing-binary");
  assert.equal(
    (resolution as { row: FileVersionResolutionRow }).row.id,
    "fv-2",
    "must report the problem against the NEWEST version, never silently substitute the older one",
  );
});

test("a newer metadata-incomplete row is skipped in favor of an older complete + present one", async () => {
  const complete = row({ id: "fv-1", versionNumber: 1, storageKey: "key-1" });
  const incomplete = row({ id: "fv-2", versionNumber: 2, checksum: null, fileSize: null, storageKey: "key-2" });
  const resolution = await resolveCurrentFileVersion(
    "doc-a",
    depsFrom([complete, incomplete], new Set(["key-1", "key-2"])),
  );
  assert.equal(resolution.kind, "ok");
  assert.equal((resolution as { row: FileVersionResolutionRow }).row.id, "fv-1");
});

test("respects maxVersionsScanned: a complete+present row beyond the scan cap is never reached", async () => {
  const rows: FileVersionResolutionRow[] = [];
  const present = new Set<string>();
  for (let v = 1; v <= 5; v += 1) {
    rows.push(row({ id: `fv-incomplete-${v}`, versionNumber: v, checksum: null, fileSize: null, storageKey: `key-${v}` }));
  }
  // The only usable row is OLDER than the scan cap allows to be seen.
  rows.push(row({ id: "fv-usable", versionNumber: 0, storageKey: "key-usable" }));
  present.add("key-usable");
  const resolution = await resolveCurrentFileVersion("doc-a", {
    ...depsFrom(rows, present),
    maxVersionsScanned: 3,
  });
  assert.equal(resolution.kind, "missing-version", "the usable row was outside the scanned window");
});

test("isBinaryBackedFileVersion rejects non-finite, negative, or wrong-typed sizes", () => {
  assert.equal(isBinaryBackedFileVersion(row({ fileSize: Number.NaN })), false);
  assert.equal(isBinaryBackedFileVersion(row({ fileSize: -1 })), false);
  assert.equal(isBinaryBackedFileVersion(row({ fileSize: null })), false);
  assert.equal(isBinaryBackedFileVersion(row({ checksum: "" })), false);
  assert.equal(isBinaryBackedFileVersion(row({ checksum: null })), false);
  assert.equal(isBinaryBackedFileVersion(row({ fileSize: 0 })), true, "zero bytes is a valid, if unusual, size");
});
