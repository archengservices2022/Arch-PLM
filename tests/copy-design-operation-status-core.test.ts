/**
 * Focused tests for the P6D ROUND 3 operation status pure core
 * (`app/lib/copy-design-operation-status-core.ts`) - `operationId` path
 * parameter validation. No Prisma, no database, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-operation-status-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COPY_DESIGN_OPERATION_STATUS_CONTRACT,
  CopyDesignOperationStatusValidationError,
  MAX_OPERATION_ID_LENGTH,
  parseOperationId,
} from "../app/lib/copy-design-operation-status-core.ts";

test("accepts a well-formed operationId verbatim", () => {
  assert.equal(parseOperationId("op-abc123"), "op-abc123");
});

test("the contract identifier is stable", () => {
  assert.equal(COPY_DESIGN_OPERATION_STATUS_CONTRACT, "arch-plm.copy-design-operation-status.v1");
});

test("rejects a blank operationId", () => {
  assert.throws(() => parseOperationId(""), CopyDesignOperationStatusValidationError);
});

test("rejects a whitespace-only operationId", () => {
  assert.throws(() => parseOperationId("   "), CopyDesignOperationStatusValidationError);
});

test("rejects a whitespace-padded operationId rather than trimming it", () => {
  assert.throws(() => parseOperationId(" op-abc123 "), CopyDesignOperationStatusValidationError);
  assert.throws(() => parseOperationId("op-abc123\n"), CopyDesignOperationStatusValidationError);
});

test("rejects an over-length operationId", () => {
  assert.throws(() => parseOperationId("x".repeat(MAX_OPERATION_ID_LENGTH + 1)), CopyDesignOperationStatusValidationError);
});

test("accepts an operationId exactly at the length cap", () => {
  const id = "x".repeat(MAX_OPERATION_ID_LENGTH);
  assert.equal(parseOperationId(id), id);
});

test("validation error carries a 400 status and a public message", () => {
  try {
    parseOperationId("");
    assert.fail("expected to throw");
  } catch (error) {
    assert.ok(error instanceof CopyDesignOperationStatusValidationError);
    assert.equal(error.status, 400);
    assert.equal(typeof error.publicMessage, "string");
  }
});
