/**
 * Focused tests for the shared safe-CAD-basename validator
 * (`app/lib/cad-basename-core.ts`) - P6D FINAL BLOCKER FIX (durable-resume
 * destination-escape hardening). No Prisma, no database, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/cad-basename-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isSafeCadBaseName } from "../app/lib/cad-basename-core.ts";

function rejected(value: unknown): void {
  const result = isSafeCadBaseName(value);
  assert.equal(result.safe, false, `expected ${JSON.stringify(value)} to be rejected`);
}

function accepted(value: unknown): void {
  const result = isSafeCadBaseName(value);
  assert.equal(result.safe, true, `expected ${JSON.stringify(value)} to be accepted (reason: ` +
    `${result.safe ? "" : result.reason})`);
}

test("rejects blank / whitespace-only / non-string input", () => {
  rejected("");
  rejected("   ");
  rejected("\t\n");
  rejected(null);
  rejected(undefined);
  rejected(42);
  rejected({});
});

test("rejects traversal / rooted / UNC / separator-containing forms (the task's exact attack list)", () => {
  rejected("..\\P6D-EVIL.ipt");
  rejected("../P6D-EVIL.ipt");
  rejected("..\\..\\outside.iam");
  rejected("C:\\Temp\\evil.ipt");
  rejected("\\\\server\\share\\evil.idw");
  rejected("subdir\\evil.ipt");
  rejected("subdir/evil.ipt");
});

test('rejects "." and ".." as the whole name', () => {
  rejected(".");
  rejected("..");
});

test("rejects a bare drive-relative prefix even without a following separator", () => {
  rejected("C:evil.ipt");
});

test("rejects trailing dot / trailing space", () => {
  rejected("P6DNEW-ROOT.iam.");
  rejected("P6DNEW-ROOT.iam ");
  rejected("evil.");
  rejected("evil ");
});

test("rejects Windows-invalid filename characters", () => {
  rejected("evil<1>.ipt");
  rejected('evil".ipt');
  rejected("evil|1.ipt");
  rejected("evil?.ipt");
  rejected("evil*.ipt");
  rejected("evil:stream.ipt");
});

test("rejects ASCII control characters", () => {
  rejected("evil\u0000.ipt");
  rejected("evil\u0007.ipt");
});

test("rejects Windows reserved device names, case-insensitively, with or without an extension", () => {
  rejected("CON");
  rejected("con");
  rejected("CON.ipt");
  rejected("con.ipt");
  rejected("Con.IAM");
  rejected("PRN.idw");
  rejected("AUX.ipt");
  rejected("NUL.ipt");
  rejected("COM1.iam");
  rejected("com1.iam");
  rejected("COM9.ipt");
  rejected("LPT1.idw");
  rejected("LPT9.idw");
});

test("does NOT reject a device name as a mere SUBSTRING of a longer basename", () => {
  accepted("MyCOM1.ipt");
  accepted("CONFIG.ipt");
  accepted("NULLABLE.ipt");
});

test("accepts ordinary, realistic CAD file names, including ones with spaces", () => {
  accepted("P6DNEW-ROOT.iam");
  accepted("1001.idw");
  accepted("A B-C_01.ipt");
  accepted("P6DNEW-REAL-PART-A.ipt");
  accepted("P6D-NESTED-SUB-A.iam");
  accepted("Bracket (Rev2).ipt");
  accepted("weld_assembly-01.dwg");
});
