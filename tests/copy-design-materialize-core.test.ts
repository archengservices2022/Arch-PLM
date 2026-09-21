/**
 * Focused tests for the P6C materialization pure core
 * (`app/lib/copy-design-materialize-core.ts`) - header/request validation.
 * No Prisma, no database, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-materialize-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CopyDesignMaterializeValidationError,
  parseMaterializeRequestHeaders,
} from "../app/lib/copy-design-materialize-core.ts";

function headers(overrides: Partial<Record<string, string | null>> = {}) {
  return {
    copyDesignOperationId: "op-1",
    sourceCadDocumentId: "src-1",
    documentType: "IPT",
    originalFileName: "10137-P001.ipt",
    expectedSha256: "a".repeat(64),
    expectedFileSize: "1024",
    ...overrides,
  };
}

test("parses a well-formed set of headers", () => {
  const meta = parseMaterializeRequestHeaders(headers(), "cad-new-1");
  assert.equal(meta.copyDesignOperationId, "op-1");
  assert.equal(meta.sourceCadDocumentId, "src-1");
  assert.equal(meta.cadDocumentId, "cad-new-1");
  assert.equal(meta.documentType, "IPT");
  assert.equal(meta.originalFileName, "10137-P001.ipt");
  assert.equal(meta.expectedSha256, "a".repeat(64));
  assert.equal(meta.expectedFileSize, 1024);
});

test("documentType is case-normalized to upper case", () => {
  const meta = parseMaterializeRequestHeaders(headers({ documentType: "iam" }), "cad-1");
  assert.equal(meta.documentType, "IAM");
});

test("sha256 is case-normalized to lower case", () => {
  const meta = parseMaterializeRequestHeaders(headers({ expectedSha256: "A".repeat(64) }), "cad-1");
  assert.equal(meta.expectedSha256, "a".repeat(64));
});

test("originalFileName is optional and defaults to null", () => {
  const meta = parseMaterializeRequestHeaders(headers({ originalFileName: null }), "cad-1");
  assert.equal(meta.originalFileName, null);
});

test("rejects malformed requests", () => {
  const cases: Array<Partial<Record<string, string | null>>> = [
    { copyDesignOperationId: null },
    { copyDesignOperationId: "" },
    { copyDesignOperationId: "   " },
    { sourceCadDocumentId: null },
    { documentType: null },
    { documentType: "STL" },
    { expectedSha256: null },
    { expectedSha256: "not-hex" },
    { expectedSha256: "a".repeat(63) }, // too short
    { expectedSha256: "a".repeat(65) }, // too long
    { expectedFileSize: null },
    { expectedFileSize: "0" },
    { expectedFileSize: "-5" },
    { expectedFileSize: "not-a-number" },
    { expectedFileSize: "1.5" },
  ];
  for (const overrides of cases) {
    assert.throws(
      () => parseMaterializeRequestHeaders(headers(overrides), "cad-1"),
      (err: unknown) => err instanceof CopyDesignMaterializeValidationError && err.status === 400,
      `expected rejection for ${JSON.stringify(overrides)}`,
    );
  }
});
