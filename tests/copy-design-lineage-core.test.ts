/**
 * Focused tests for the P6B Copy Design pure core
 * (`app/lib/copy-design-lineage-core.ts`) - request parsing/validation and
 * idempotent-retry canonicalization. No Prisma, no database, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-lineage-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalCopyDesignPayload,
  copyDesignPayloadsEqual,
  CopyDesignValidationError,
  isStrictJsonContentType,
  MAX_DESCRIPTION_LENGTH,
  MAX_ENTRIES_PER_OPERATION,
  parseCopyDesignApplyRequest,
} from "../app/lib/copy-design-lineage-core.ts";

function copyEntry(overrides: Record<string, unknown> = {}) {
  return {
    action: "COPY",
    sourceCadDocumentId: "src_1",
    sourceFileVersionId: "fv_1",
    newDocumentNumber: "10137-P001",
    newFileName: "10137-P001.ipt",
    documentType: "IPT",
    ...overrides,
  };
}

test("parses a well-formed COPY + REUSE request, trimming and defaulting", () => {
  const request = parseCopyDesignApplyRequest({
    idempotencyKey: "  key-1  ",
    label: "  10073 -> 10137  ",
    entries: [
      copyEntry({ description: "  a note  " }),
      { action: "REUSE", cadDocumentId: " reuse_1 " },
    ],
  });

  assert.equal(request.idempotencyKey, "key-1");
  assert.equal(request.label, "10073 -> 10137");
  assert.equal(request.entries.length, 2);
  assert.deepEqual(request.entries[0], {
    action: "COPY",
    sourceCadDocumentId: "src_1",
    sourceFileVersionId: "fv_1",
    newDocumentNumber: "10137-P001",
    newFileName: "10137-P001.ipt",
    documentType: "IPT",
    description: "a note",
  });
  assert.deepEqual(request.entries[1], { action: "REUSE", cadDocumentId: "reuse_1" });
});

test("label and description default to null when absent/blank", () => {
  const request = parseCopyDesignApplyRequest({
    idempotencyKey: "key",
    entries: [copyEntry()],
  });
  assert.equal(request.label, null);
  assert.equal((request.entries[0] as { description: string | null }).description, null);
});

test("rejects malformed requests", () => {
  const cases: unknown[] = [
    null,
    {},
    { idempotencyKey: "" },
    { idempotencyKey: "  " },
    { idempotencyKey: "k", entries: [] },
    { idempotencyKey: "k", entries: "not-an-array" },
    { idempotencyKey: "k", entries: [{ action: "DELETE" }] },
    { idempotencyKey: "k", entries: [copyEntry({ documentType: "STL" })] },
    { idempotencyKey: "k", entries: [copyEntry({ sourceCadDocumentId: "" })] },
    { idempotencyKey: "k", entries: [{ action: "REUSE" }] },
    {
      idempotencyKey: "k",
      entries: [copyEntry({ newDocumentNumber: "DUP" }), copyEntry({ newDocumentNumber: "DUP" })],
    },
  ];
  for (const bad of cases) {
    assert.throws(
      () => parseCopyDesignApplyRequest(bad),
      (err: unknown) => err instanceof CopyDesignValidationError && err.status === 400,
    );
  }
});

test("rejects an entries array over the hard cap", () => {
  const entries = Array.from({ length: MAX_ENTRIES_PER_OPERATION + 1 }, (_, i) =>
    copyEntry({ newDocumentNumber: `NUM-${i}`, newFileName: `NUM-${i}.ipt` }),
  );
  assert.throws(
    () => parseCopyDesignApplyRequest({ idempotencyKey: "k", entries }),
    (err: unknown) => err instanceof CopyDesignValidationError,
  );
});

// ------------------------------------------------------------
// Canonicalization / idempotent-retry comparison
// ------------------------------------------------------------

test("identical requests canonicalize to equal payloads", () => {
  const a = parseCopyDesignApplyRequest({ idempotencyKey: "k", entries: [copyEntry(), { action: "REUSE", cadDocumentId: "r1" }] });
  const b = parseCopyDesignApplyRequest({ idempotencyKey: "k", entries: [copyEntry(), { action: "REUSE", cadDocumentId: "r1" }] });
  assert.ok(copyDesignPayloadsEqual(canonicalCopyDesignPayload(a), canonicalCopyDesignPayload(b)));
});

test("the label is NOT part of the canonical payload - changing it alone is not a material difference", () => {
  const a = parseCopyDesignApplyRequest({ idempotencyKey: "k", label: "one", entries: [copyEntry()] });
  const b = parseCopyDesignApplyRequest({ idempotencyKey: "k", label: "two", entries: [copyEntry()] });
  assert.ok(copyDesignPayloadsEqual(canonicalCopyDesignPayload(a), canonicalCopyDesignPayload(b)));
});

test("a different source, destination, or action IS a material difference", () => {
  const base = parseCopyDesignApplyRequest({ idempotencyKey: "k", entries: [copyEntry()] });
  const differentSource = parseCopyDesignApplyRequest({
    idempotencyKey: "k",
    entries: [copyEntry({ sourceCadDocumentId: "src_2" })],
  });
  const differentDestination = parseCopyDesignApplyRequest({
    idempotencyKey: "k",
    entries: [copyEntry({ newDocumentNumber: "10137-P999" })],
  });
  const reuseInstead = parseCopyDesignApplyRequest({
    idempotencyKey: "k",
    entries: [{ action: "REUSE", cadDocumentId: "src_1" }],
  });

  const baseCanonical = canonicalCopyDesignPayload(base);
  assert.equal(copyDesignPayloadsEqual(baseCanonical, canonicalCopyDesignPayload(differentSource)), false);
  assert.equal(copyDesignPayloadsEqual(baseCanonical, canonicalCopyDesignPayload(differentDestination)), false);
  assert.equal(copyDesignPayloadsEqual(baseCanonical, canonicalCopyDesignPayload(reuseInstead)), false);
});

test("reordering the SAME entries is treated as a different request (order-sensitive)", () => {
  const a = parseCopyDesignApplyRequest({
    idempotencyKey: "k",
    entries: [copyEntry({ newDocumentNumber: "A" }), copyEntry({ newDocumentNumber: "B" })],
  });
  const b = parseCopyDesignApplyRequest({
    idempotencyKey: "k",
    entries: [copyEntry({ newDocumentNumber: "B" }), copyEntry({ newDocumentNumber: "A" })],
  });
  assert.equal(copyDesignPayloadsEqual(canonicalCopyDesignPayload(a), canonicalCopyDesignPayload(b)), false);
});

// ------------------------------------------------------------
// ROUND 2, MEDIUM: overlong description must REJECT, never truncate
// ------------------------------------------------------------

test("a description exactly MAX_DESCRIPTION_LENGTH is accepted, unmodified", () => {
  const description = "d".repeat(MAX_DESCRIPTION_LENGTH);
  const request = parseCopyDesignApplyRequest({
    idempotencyKey: "k",
    entries: [copyEntry({ description })],
  });
  assert.equal((request.entries[0] as { description: string | null }).description, description);
});

test("a description one character over MAX_DESCRIPTION_LENGTH is REJECTED, not truncated", () => {
  const description = "d".repeat(MAX_DESCRIPTION_LENGTH + 1);
  assert.throws(
    () => parseCopyDesignApplyRequest({ idempotencyKey: "k", entries: [copyEntry({ description })] }),
    (err: unknown) => err instanceof CopyDesignValidationError && err.status === 400,
  );
});

test("two descriptions differing ONLY after MAX_DESCRIPTION_LENGTH characters can never collapse to the same canonical payload (rejected, not silently equated)", () => {
  const base = "d".repeat(MAX_DESCRIPTION_LENGTH);
  // Both variants are themselves over the cap - rejected outright, so they
  // can never even reach canonicalization to be silently treated as equal
  // the way truncate-then-compare would have allowed.
  for (const description of [`${base}A-tail-that-must-not-be-dropped`, `${base}B-a-totally-different-tail`]) {
    assert.throws(
      () => parseCopyDesignApplyRequest({ idempotencyKey: "k", entries: [copyEntry({ description })] }),
      (err: unknown) => err instanceof CopyDesignValidationError,
    );
  }
});

// ------------------------------------------------------------
// ROUND 2, LOW 3: strict Content-Type parsing
// ------------------------------------------------------------

test("isStrictJsonContentType accepts exact media type, with or without parameters, case-insensitively", () => {
  assert.equal(isStrictJsonContentType("application/json"), true);
  assert.equal(isStrictJsonContentType("application/json; charset=utf-8"), true);
  assert.equal(isStrictJsonContentType("Application/Json"), true);
  assert.equal(isStrictJsonContentType("  application/json  "), true);
});

test("isStrictJsonContentType rejects substring matches, related types, and missing headers", () => {
  assert.equal(isStrictJsonContentType("text/application/jsonx"), false);
  assert.equal(isStrictJsonContentType("application/jsonx"), false);
  assert.equal(isStrictJsonContentType("application/json-patch+json"), false);
  assert.equal(isStrictJsonContentType("text/plain"), false);
  assert.equal(isStrictJsonContentType(null), false);
  assert.equal(isStrictJsonContentType(undefined), false);
  assert.equal(isStrictJsonContentType(""), false);
});
