/**
 * FE-L3: unit tests for keeping typed input after a refusal notice
 * (`app/lib/kept-form-core.ts`, and which refusals keep input in
 * `action-notice-core.ts` / `user-admin-notice-core.ts`).
 *
 * Covers: only allowlisted, non-secret, plain-string values are returned (in
 * full); passwords are never returned (B05 create-user form); the counter
 * tolerates a forged previous state; render-time defaults never fill password
 * / hidden / file inputs; only user-correctable refusals keep input, while
 * authorization refusals keep their redirect; the wiring in actions and pages.
 *
 * Run with:  node --experimental-strip-types --test tests/kept-form-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  completedFormState,
  INITIAL_KEPT_FORM_STATE,
  isSecretFieldName,
  KEPT_FORM_FIELDS,
  keptFormValues,
  keptInputDefault,
  keptSelectDefault,
  refusedFormState,
} from "../app/lib/kept-form-core.ts";
import { allNoticeCodes, keepsInputAfterRefusal } from "../app/lib/action-notice-core.ts";
import {
  allUserAdminNoticeCodes,
  isCreateUserCorrectableRefusal,
  type UserAdminNoticeCode,
} from "../app/lib/user-admin-notice-core.ts";

function createUserFormData(): FormData {
  const formData = new FormData();
  formData.set("email", "new.user@arch.test");
  formData.set("name", "New User");
  formData.set("role", "ENGINEER");
  formData.set("password", "correct horse battery staple");
  formData.set("passwordConfirmation", "correct horse battery staple");
  formData.set("$ACTION_ID_abc", "");
  return formData;
}

test("B05 create user: a refusal keeps email, name and role - never a password", () => {
  const state = refusedFormState(INITIAL_KEPT_FORM_STATE, "A user with that email already exists.", createUserFormData(), KEPT_FORM_FIELDS.createUser);
  assert.deepEqual(state.values, { email: "new.user@arch.test", name: "New User", role: "ENGINEER" });
  assert.equal(state.notice, "A user with that email already exists.");
  assert.equal(state.submission, 1);
  assert.doesNotMatch(JSON.stringify(state), /correct horse/);
});

test("a secret-looking field is never kept, even if an allowlist names it", () => {
  const formData = createUserFormData();
  formData.set("token", "t0k3n");
  formData.set("clientSecret", "s3cr3t");
  formData.set("apiKey", "k3y");
  const values = keptFormValues(formData, ["email", "password", "passwordConfirmation", "token", "clientSecret", "apiKey"]);
  assert.deepEqual(values, { email: "new.user@arch.test" });
  for (const name of ["password", "passwordConfirmation", "newPassword", "currentPassword", "token", "secret", "credentials", "api_key", "otp"]) {
    assert.ok(isSecretFieldName(name), `${name} is treated as secret`);
  }
  for (const name of ["email", "name", "role", "itemNumber", "description", "fileName", "projectId"]) {
    assert.ok(!isSecretFieldName(name), `${name} is not treated as secret`);
  }
});

test("every form allowlist is free of secret-looking names", () => {
  for (const [form, fields] of Object.entries(KEPT_FORM_FIELDS)) {
    for (const name of fields) assert.ok(!isSecretFieldName(name), `${form}.${name}`);
  }
  assert.ok(!(KEPT_FORM_FIELDS.createUser as readonly string[]).includes("password"));
});

test("only allowlisted string fields are kept; files and missing fields are dropped; long values are kept in full", () => {
  const formData = new FormData();
  const longDescription = "x".repeat(100_000);
  formData.set("itemNumber", "10073-MFD-BR018");
  formData.set("description", longDescription);
  formData.set("revision", "");
  formData.set("notAllowlisted", "ignored");
  formData.set("type", new Blob(["file"]), "file.txt");
  const values = keptFormValues(formData, KEPT_FORM_FIELDS.createItem);
  assert.deepEqual(values, { itemNumber: "10073-MFD-BR018", description: longDescription, revision: "" });
});

test("submitted values are returned as typed (not trimmed or upper-cased)", () => {
  const formData = new FormData();
  formData.set("fileName", "  bracket.ipt ");
  const state = refusedFormState(null, "msg", formData, KEPT_FORM_FIELDS.createCadDocument);
  assert.equal(state.values.fileName, "  bracket.ipt ");
});

test("success clears notice and values; the counter increments", () => {
  const refused = refusedFormState(INITIAL_KEPT_FORM_STATE, "msg", createUserFormData(), KEPT_FORM_FIELDS.createUser);
  const done = completedFormState(refused);
  assert.deepEqual(done, { submission: 2, notice: null, values: {} });
});

test("a forged or missing previous state restarts the counter at 1", () => {
  for (const previous of [undefined, null, "x", {}, { submission: -1 }, { submission: 1.5 }, { submission: "3" }, { submission: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(completedFormState(previous).submission, 1, JSON.stringify(previous));
  }
  assert.equal(completedFormState({ submission: 41 }).submission, 42);
});

// ------------------------------------------------------------
// Render-time defaults (<KeptInput>, <KeptSelect>)
// ------------------------------------------------------------

test("keptInputDefault: the kept value for text-like inputs, else the field's own default", () => {
  const values = { email: "a@b.test", itemNumber: "X-1", description: "" };
  assert.equal(keptInputDefault(values, "email", "email", undefined), "a@b.test");
  assert.equal(keptInputDefault(values, "itemNumber", undefined, undefined), "X-1");
  assert.equal(keptInputDefault(values, "description", undefined, "fallback"), "", "an empty kept value is still the typed value");
  assert.equal(keptInputDefault(values, "fileName", undefined, "fallback"), "fallback");
  assert.equal(keptInputDefault({}, "email", "email", undefined), undefined);
});

test("keptInputDefault: never fills password, hidden, file or secret-named fields", () => {
  const values = { password: "leak", passwordConfirmation: "leak", userId: "forged", upload: "x", passwordHint: "leak" };
  assert.equal(keptInputDefault(values, "password", "password", undefined), undefined);
  assert.equal(keptInputDefault(values, "passwordConfirmation", "text", undefined), undefined);
  assert.equal(keptInputDefault(values, "passwordHint", "text", undefined), undefined);
  assert.equal(keptInputDefault(values, "userId", "hidden", "u1"), "u1");
  assert.equal(keptInputDefault(values, "upload", "FILE", undefined), undefined);
  assert.equal(keptInputDefault({ toString: "x" } as Record<string, unknown>, "constructor", "text", undefined), undefined, "no prototype lookups");
});

test("keptSelectDefault: the kept option only if the select still offers it", () => {
  assert.equal(keptSelectDefault({ role: "ENGINEER" }, "role", ["VIEWER", "ENGINEER"], "VIEWER"), "ENGINEER");
  assert.equal(keptSelectDefault({ projectId: "p-deleted" }, "projectId", ["", "p1"], "p1"), "p1");
  assert.equal(keptSelectDefault({ projectId: "" }, "projectId", ["", "p1"], "p1"), "", "Unassigned is kept");
  assert.equal(keptSelectDefault({}, "type", ["PART"], "PART"), "PART");
});

// ------------------------------------------------------------
// Which refusals keep the input (C-1)
// ------------------------------------------------------------

test("dashboard: only form/data refusals keep input; role and permission refusals keep the redirect", () => {
  for (const code of allNoticeCodes()) {
    const keeps = keepsInputAfterRefusal(code);
    if (/ROLE_NOT_PERMITTED|^lifecycle\.|^revalidation\.|^state\.|^release\.|^comment\./.test(code)) {
      assert.equal(keeps, false, `${code} must redirect`);
    }
  }
  for (const code of ["action.FIELD_REQUIRED", "action.ITEM_NUMBER_EXISTS", "action.CAD_DOCUMENT_EXISTS", "action.CONCURRENT_CHANGES"]) {
    assert.ok(keepsInputAfterRefusal(code as Parameters<typeof keepsInputAfterRefusal>[0]), code);
  }
});

test("B05 create user: USER_ADMIN_NOT_ADMIN (and other non-form refusals, success) keep the redirect", () => {
  const code = (raw: string) => raw as UserAdminNoticeCode;
  assert.equal(isCreateUserCorrectableRefusal(code("refused.USER_ADMIN_NOT_ADMIN")), false);
  for (const c of allUserAdminNoticeCodes()) {
    if (c.startsWith("ok.")) assert.equal(isCreateUserCorrectableRefusal(c), false, c);
  }
  for (const c of ["refused.USER_ADMIN_USER_NOT_FOUND", "refused.USER_ADMIN_SELF_ROLE", "refused.USER_ADMIN_LAST_ADMIN", "refused.UNEXPECTED"]) {
    assert.equal(isCreateUserCorrectableRefusal(code(c)), false, c);
  }
  for (const c of [
    "refused.USER_ADMIN_EMAIL_INVALID",
    "refused.USER_ADMIN_EMAIL_EXISTS",
    "refused.USER_ADMIN_NAME_INVALID",
    "refused.USER_ADMIN_PASSWORD_MISMATCH",
    "refused.USER_ADMIN_PASSWORD_TOO_SHORT",
  ]) {
    assert.ok(isCreateUserCorrectableRefusal(code(c)), c);
    assert.ok(allUserAdminNoticeCodes().includes(code(c)), `${c} is allowlisted`);
  }
});

// ------------------------------------------------------------
// Wiring (source checks)
// ------------------------------------------------------------

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

test("wiring: the kept-input actions return their allowlist on refusal; role refusal and authz are unchanged", () => {
  const actions = source("../app/actions.ts");
  for (const [name, list] of [["createItem", "createItem"], ["createCadDocument", "createCadDocument"]] as const) {
    const start = actions.indexOf(`export async function ${name}(`);
    const body = actions.slice(start, actions.indexOf("\n}\n", start));
    assert.match(body, /previous: KeptFormState,\s*formData: FormData,?\s*\): Promise<KeptFormState>/);
    assert.match(body, /await refuseUnlessWriteRole\(actor\);[^\n]*\n  assertCanMutate\(actor\);/);
    assert.ok(body.includes(`fields: KEPT_FORM_FIELDS.${list} }`), `${name} keeps KEPT_FORM_FIELDS.${list}`);
    assert.match(body, /if \(refused !== null\) return refused;\n\n  revalidatePath\("\/"\);\n  return completedFormState\(previous\);/);
  }
  assert.match(actions, /if \(keep && keepsInputAfterRefusal\(notice\.code\)\) \{/);
  const admin = source("../app/admin/users/actions.ts");
  assert.match(
    admin,
    /if \(isCreateUserCorrectableRefusal\(code\)\) \{\n    return refusedFormState\(previous, userAdminNotice\(code\)\.message, formData, KEPT_FORM_FIELDS\.createUser\);\n  \}\n  redirect\(userAdminNoticeHref\(code\)\);/,
  );
});

test("wiring: the three main create forms use KeepInputForm with kept fields; password fields stay plain inputs", () => {
  const page = source("../app/page.tsx");
  assert.match(page, /<KeepInputForm action=\{createItem\}/);
  assert.match(page, /<KeepInputForm\n\s+action=\{createCadDocument\}/);
  for (const name of ["itemRevisionId", "documentType", "type", "projectId"]) {
    assert.match(page, new RegExp(`<KeptSelect\\n\\s+name="${name}"`), name);
  }
  // DD-ATTACH: File name + Document number live in AttachNumberFields, inside the Attach form.
  assert.match(page, /<AttachNumberFields\n/);
  const attach = source("../app/components/attach-number-fields.tsx");
  assert.match(attach, /<KeptInput\n\s+name="fileName"/);
  // DD-1: an explicit "the user owns the number" flag, set by the number box's own edits and on mount.
  assert.match(attach, /if \(number && !userOwnsNumber\.current\) number\.value = fileNameStem/);
  assert.match(attach, /userOwnsNumber\.current = event\.currentTarget\.value !== ""/);
  assert.match(attach, /userOwnsNumber\.current = \(numberRef\.current\?\.value \?\? ""\) !== ""/);
  assert.match(attach, /<KeptInput\n\s+ref=\{numberRef\}\n\s+name="documentNumber"/);
  const admin = source("../app/admin/users/page.tsx");
  assert.match(admin, /<KeepInputForm\n\s+action=\{createUserAction\}/);
  assert.match(admin, /<KeptInput name="email"/);
  assert.match(admin, /<KeptInput name="name"/);
  assert.match(admin, /<KeptSelect name="role"/);
  assert.equal((admin.match(/type="password"/g) ?? []).length, 2);
  assert.doesNotMatch(admin, /<KeptInput[^>]*password/i);
  assert.doesNotMatch(admin, /defaultValue=\{[^}]*password/i);
});
