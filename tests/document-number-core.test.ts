/**
 * DD-ATTACH: the document number of a CAD document attached from the dashboard
 * (`app/lib/document-number-core.ts`; D-D DD-3(a): numbers WITHOUT the file
 * extension). No Prisma, no database, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/document-number-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAD_FILE_EXTENSIONS,
  fileNameStem,
  knownCadExtension,
  resolveAttachDocumentNumber,
} from "../app/lib/document-number-core.ts";
import { ACTION_REFUSAL_MESSAGES, keepsInputAfterRefusal } from "../app/lib/action-notice-core.ts";
import { KEPT_FORM_FIELDS } from "../app/lib/kept-form-core.ts";

test("every CadDocumentType with a file extension is a known extension", () => {
  for (const ext of ["ipt", "iam", "idw", "dwg", "pdf"]) assert.ok(CAD_FILE_EXTENSIONS.has(ext), ext);
});

test("knownCadExtension: case-insensitive, last dot only, unknown and bare names are not extensions", () => {
  assert.equal(knownCadExtension("10073-MFD-AS210.iam"), "iam");
  assert.equal(knownCadExtension("PART.IPT"), "ipt");
  assert.equal(knownCadExtension("Drawing.Idw"), "idw");
  assert.equal(knownCadExtension("A.B.dwg"), "dwg");
  assert.equal(knownCadExtension(".ipt"), "ipt");
  assert.equal(knownCadExtension("10073-MFD-AS210"), null);
  assert.equal(knownCadExtension("PUMP-REV.2"), null);
  assert.equal(knownCadExtension("ASSY.A"), null);
  assert.equal(knownCadExtension("notes.txt"), null);
  assert.equal(knownCadExtension("trailing."), null);
  assert.equal(knownCadExtension("iam"), null);
});

test("fileNameStem removes ONE known extension and trims", () => {
  assert.equal(fileNameStem("10073-MFD-AS210.iam"), "10073-MFD-AS210");
  assert.equal(fileNameStem("  A B-C_01.ipt  "), "A B-C_01");
  assert.equal(fileNameStem("A.B.ipt"), "A.B");
  assert.equal(fileNameStem("X.ipt.ipt"), "X.ipt");
  assert.equal(fileNameStem("notes.txt"), "notes.txt");
  assert.equal(fileNameStem("NO-EXT"), "NO-EXT");
  assert.equal(fileNameStem(".ipt"), "");
  assert.equal(fileNameStem("name .iam"), "name");
});

test("resolveAttachDocumentNumber: typed number wins; empty number -> the file name's stem", () => {
  assert.deepEqual(resolveAttachDocumentNumber(undefined, "10073-MFD-AS210.iam"), { ok: true, documentNumber: "10073-MFD-AS210" });
  assert.deepEqual(resolveAttachDocumentNumber("10073-MFD-AS210", "other.iam"), { ok: true, documentNumber: "10073-MFD-AS210" });
  assert.deepEqual(resolveAttachDocumentNumber("PUMP-REV.2", "pump.ipt"), { ok: true, documentNumber: "PUMP-REV.2" });
  assert.deepEqual(resolveAttachDocumentNumber(undefined, "NO-EXT"), { ok: true, documentNumber: "NO-EXT" });
});

test("resolveAttachDocumentNumber refuses a number that ends in a known extension (typed or derived)", () => {
  assert.deepEqual(resolveAttachDocumentNumber("10073-MFD-AS210.iam", "x.iam"), { ok: false, reason: "HAS_EXTENSION" });
  assert.deepEqual(resolveAttachDocumentNumber("PART.IPT", "x.ipt"), { ok: false, reason: "HAS_EXTENSION" });
  // a file name with a doubled extension yields a stem that still has one
  assert.deepEqual(resolveAttachDocumentNumber(undefined, "X.ipt.ipt"), { ok: false, reason: "HAS_EXTENSION" });
  assert.deepEqual(resolveAttachDocumentNumber(undefined, ".ipt"), { ok: false, reason: "EMPTY" });
});

test("the refusal is a correctable notice that keeps the input, and the number is a kept field", () => {
  assert.match(ACTION_REFUSAL_MESSAGES.DOCUMENT_NUMBER_HAS_EXTENSION, /without the file extension/);
  assert.ok(keepsInputAfterRefusal("action.DOCUMENT_NUMBER_HAS_EXTENSION" as Parameters<typeof keepsInputAfterRefusal>[0]));
  assert.ok((KEPT_FORM_FIELDS.createCadDocument as readonly string[]).includes("documentNumber"));
});

test("createCadDocument resolves the number through the core module (no raw file-name fallback)", () => {
  const actions = readFileSync(new URL("../app/actions.ts", import.meta.url), "utf8");
  assert.match(actions, /resolveAttachDocumentNumber\(optionalValue\(formData, "documentNumber"\), fileName\)/);
  assert.doesNotMatch(actions, /optionalValue\(formData, "documentNumber"\) \?\? fileName/);
});
