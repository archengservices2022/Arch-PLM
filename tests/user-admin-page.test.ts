/**
 * B05 commit 2: the /admin/users notices, the page's data gate (AC1) and
 * source checks on the page and its Server Actions.
 *   node --experimental-strip-types --test tests/user-admin-page.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  allUserAdminNoticeCodes,
  classifyUserAdminError,
  describeUnexpectedError,
  parseUserAdminNotice,
  runUserAdminAction,
  userAdminNotice,
  userAdminNoticeHref,
  userAdminSuccessCode,
  type UserAdminNoticeCode,
} from "../app/lib/user-admin-notice-core.ts";
import { USER_ADMIN_REFUSAL_MESSAGES, UserAdminRefusalError } from "../app/lib/user-admin-core.ts";
import { ActionRefusalError } from "../app/lib/action-notice-core.ts";
import { loadAdminUsersView, type UserAdminViewDb } from "../app/lib/user-admin-view-db.ts";

// ------------------------------------------------------------
// Notices
// ------------------------------------------------------------

test("notices: every refusal code, CONCURRENT_CHANGES, UNEXPECTED and the five successes are allowlisted", () => {
  const codes = allUserAdminNoticeCodes();
  for (const code of Object.keys(USER_ADMIN_REFUSAL_MESSAGES)) {
    assert.ok(codes.includes(`refused.${code}` as UserAdminNoticeCode), code);
  }
  for (const code of ["refused.CONCURRENT_CHANGES", "refused.UNEXPECTED", "ok.CREATED", "ok.ROLE_CHANGED", "ok.DEACTIVATED", "ok.REACTIVATED", "ok.PASSWORD_RESET", "ok.UNLOCKED", "ok.NOT_LOCKED"]) {
    assert.ok(codes.includes(code as UserAdminNoticeCode), code);
  }
  for (const code of codes) {
    assert.ok(code.length <= 64, code);
    assert.equal(userAdminNotice(code).kind, code.startsWith("ok.") ? "success" : "refused");
  }
});

test("notices: anything not exactly allowlisted is ignored", () => {
  for (const raw of [undefined, "", "ok.created", "refused.", "<script>", ["ok.CREATED"], "ok.CREATED ", "x".repeat(65), "constructor", "__proto__", "toString"]) {
    assert.equal(parseUserAdminNotice(raw), null, String(raw));
  }
  assert.equal(parseUserAdminNotice("ok.CREATED"), "ok.CREATED");
  assert.equal(userAdminNoticeHref(userAdminSuccessCode("CREATED")), "/admin/users?notice=ok.CREATED");
});

test("classification: refusals and the final conflict map to notices; other errors do not", () => {
  assert.equal(classifyUserAdminError(new UserAdminRefusalError("USER_ADMIN_LAST_ADMIN")), "refused.USER_ADMIN_LAST_ADMIN");
  assert.equal(classifyUserAdminError(new ActionRefusalError("CONCURRENT_CHANGES")), "refused.CONCURRENT_CHANGES");
  assert.equal(classifyUserAdminError(new ActionRefusalError("FIELD_REQUIRED")), null);
  assert.equal(classifyUserAdminError(new Error("db down")), null);
  assert.equal(classifyUserAdminError(Object.assign(new Error("x"), { digest: "NEXT_REDIRECT;replace;/" })), null);
});

test("run: success -> success notice; refusal -> its notice; unexpected -> UNEXPECTED notice and a log line without the message (L-1)", async () => {
  const lines: string[] = [];
  const logUnexpected = (line: string) => lines.push(line);

  const ok = await runUserAdminAction(async () => 7, () => userAdminSuccessCode("CREATED"), { logUnexpected });
  assert.deepEqual(ok, { code: "ok.CREATED", value: 7 });

  const refused = await runUserAdminAction(
    async () => {
      throw new UserAdminRefusalError("USER_ADMIN_EMAIL_EXISTS");
    },
    () => userAdminSuccessCode("CREATED"),
    { logUnexpected },
  );
  assert.deepEqual(refused, { code: "refused.USER_ADMIN_EMAIL_EXISTS", value: null });
  assert.deepEqual(lines, []);

  const secretInMessage = Object.assign(
    new Error('Invalid `prisma.user.create()` invocation: { passwordHash: "$2a$12$secret", email: "x@y.io" }'),
    { name: "PrismaClientKnownRequestError", code: "P1001" },
  );
  const unexpected = await runUserAdminAction(
    async () => {
      throw secretInMessage;
    },
    () => userAdminSuccessCode("CREATED"),
    { logUnexpected },
  );
  assert.deepEqual(unexpected, { code: "refused.UNEXPECTED", value: null });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "user_admin action failed unexpectedly: PrismaClientKnownRequestError P1001");
  assert.ok(!lines[0].includes("secret") && !lines[0].includes("x@y.io"));
});

test("run: Next.js control flow is rethrown, never turned into a notice", async () => {
  const redirectError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
  await assert.rejects(
    runUserAdminAction(
      async () => {
        throw redirectError;
      },
      () => userAdminSuccessCode("CREATED"),
      { logUnexpected: () => assert.fail("must not log") },
    ),
    (error: unknown) => error === redirectError,
  );
});

test("describeUnexpectedError: name and a short code only", () => {
  assert.equal(describeUnexpectedError(new TypeError("boom: secret")), "TypeError");
  assert.equal(describeUnexpectedError(Object.assign(new Error("m"), { code: "P2002" })), "Error P2002");
  assert.equal(describeUnexpectedError(Object.assign(new Error("m"), { code: "not a code; secret" })), "Error");
  assert.equal(describeUnexpectedError("plain string secret"), "string");
});

// ------------------------------------------------------------
// AC1: the page's data gate
// ------------------------------------------------------------

function fakeViewDb() {
  const calls: unknown[] = [];
  const db = {
    user: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return [
          { id: "a1", email: "admin@arch.test", name: "Admin", role: "ADMIN", active: true, lastLoginAt: null },
          { id: "e1", email: "eng@arch.test", name: "Eng", role: "ENGINEER", active: false, lastLoginAt: null },
        ];
      },
    },
  } as unknown as UserAdminViewDb;
  return { db, calls };
}

test("AC1 page: VIEWER / ENGINEER / any non-admin gets no user data - nothing is queried", async () => {
  for (const role of ["VIEWER", "ENGINEER", "DESIGNER", "REVIEWER", "APPROVER"] as const) {
    const { db, calls } = fakeViewDb();
    const view = await loadAdminUsersView({ userId: "u", organizationId: "o1", role }, db);
    assert.deepEqual(view, { allowed: false }, role);
    assert.equal(calls.length, 0, role);
  }
});

test("AC1 page: an ADMIN gets the own organization's users, without password hashes, self marked", async () => {
  const { db, calls } = fakeViewDb();
  const asked: string[] = [];
  const view = await loadAdminUsersView({ userId: "a1", organizationId: "o1", role: "ADMIN" }, db, (email) => {
    asked.push(email);
    return email === "eng@arch.test";
  });
  assert.ok(view.allowed);
  assert.deepEqual(
    view.users.map((u) => [u.id, u.isSelf, u.signInLocked]),
    [
      ["a1", true, false],
      ["e1", false, true],
    ],
  );
  assert.deepEqual(asked, ["admin@arch.test", "eng@arch.test"]);
  const args = calls[0] as { where: unknown; select: Record<string, boolean> };
  assert.deepEqual(args.where, { organizationId: "o1" });
  assert.equal(args.select.passwordHash, undefined);
});

// ------------------------------------------------------------
// Source checks (in addition to the behavioural tests above and in
// user-admin-db.test.ts, which call every action with a non-admin actor)
// ------------------------------------------------------------

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("source: the actions take the actor only from requireActor(); FormData never supplies organization, role of the actor or actor id", () => {
  const actions = source("../app/admin/users/actions.ts");
  assert.match(actions, /^"use server";/);
  const fields = [...actions.matchAll(/field\(formData, "([A-Za-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fields)].sort(), ["confirm", "email", "name", "password", "passwordConfirmation", "role", "userId"]);
  assert.equal((actions.match(/formData\.get\(/g) ?? []).length, 1, "only the field() helper reads FormData");
  assert.match(
    actions,
    /return \{ userId: actor\.userId, organizationId: actor\.organizationId, role: actor\.role \};/,
  );
  assert.doesNotMatch(actions, /organizationId: field|userId: field|actorUserId/);
  assert.match(actions, /const actor = await requireActor\(\);/);
  // FE-L3: createUserAction also takes the useActionState state first.
  const exported = [
    ...actions.matchAll(
      /export async function (\w+)\((?:previous: KeptFormState, )?formData: FormData\)(?:: Promise<KeptFormState>)? \{\r?\n  const actor = await adminActor\(\);/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(exported.sort(), [
    "changeUserRoleAction",
    "createUserAction",
    "deactivateUserAction",
    "reactivateUserAction",
    "resetUserPasswordAction",
    "unlockSignInAction",
  ]);
  // Every outcome goes through the notice runner, then a redirect.
  assert.equal((actions.match(/runUserAdminAction\(/g) ?? []).length, 6);
  assert.equal((actions.match(/redirect\(userAdminNoticeHref\(code\)\)/g) ?? []).length, 6);
});

test("source: the page gates its data on loadAdminUsersView and never selects a password hash", () => {
  const page = source("../app/admin/users/page.tsx");
  assert.match(page, /const actor = await requireDashboardActor\(\);\r?\n  const view = await loadAdminUsersView\(actor, prisma\);/);
  assert.equal((page.match(/prisma\./g) ?? []).length, 0, "no direct query in the page");
  assert.doesNotMatch(page, /passwordHash/);
  assert.match(page, /\{!view\.allowed \? \(/);
  // C2-L3: no notice for a non-admin.
  assert.match(page, /const noticeCode = view\.allowed \? parseUserAdminNotice\(/);
  // C2-L2: the deactivate form carries the confirmation checkbox.
  assert.match(page, /name="confirm" value=\{DEACTIVATE_CONFIRMATION_VALUE\} required/);
});
