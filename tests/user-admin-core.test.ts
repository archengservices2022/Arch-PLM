/**
 * B05 user administration - pure rules (app/lib/user-admin-core.ts).
 *   node --experimental-strip-types --test tests/user-admin-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  assertActorIsLockedAdmin,
  assertNotLastActiveAdmin,
  buildUserAdminLogEntry,
  MAX_PASSWORD_BYTES,
  MIN_FIRST_ADMIN_PASSWORD_CHARS,
  normalizeEmail,
  normalizeName,
  parseRole,
  passwordVersion,
  passwordVersionMatches,
  UserAdminRefusalError,
  validateNewPassword,
  type UserAdminRefusalCode,
} from "../app/lib/user-admin-core.ts";

function refusedWith(code: UserAdminRefusalCode) {
  return (error: unknown) => error instanceof UserAdminRefusalError && error.code === code;
}

test("email: trimmed and lower-cased", () => {
  assert.equal(normalizeEmail("  Jane.Doe_1+cad@Example.COM "), "jane.doe_1+cad@example.com");
});

test("email: refuses non-ASCII, wildcard/escape characters, spaces, missing parts, too long", () => {
  for (const bad of [
    "jäne@example.com",
    "jane%@example.com",
    "ja\\ne@example.com",
    "jane doe@example.com",
    "jane@example",
    "@example.com",
    "jane@@example.com",
    "",
    "   ",
    `${"a".repeat(250)}@x.io`,
    42,
    null,
  ]) {
    assert.throws(() => normalizeEmail(bad), refusedWith("USER_ADMIN_EMAIL_INVALID"), String(bad));
  }
  assert.equal(normalizeEmail(`${"a".repeat(249)}@x.io`).length, 254);
});

test("name: trimmed, 1-100 code points, no control characters", () => {
  assert.equal(normalizeName("  Jane Doe "), "Jane Doe");
  assert.equal(normalizeName("é".repeat(100)).length, 100);
  for (const bad of ["", "   ", "x".repeat(101), "a\nb", "Ann\u202eeK", "Bob\u2067x", "a\u200fb", "a\u0085b", "a\u200bb", "a\u061cb", "An\ufeffn", undefined]) {
    assert.throws(() => normalizeName(bad), refusedWith("USER_ADMIN_NAME_INVALID"));
  }
});

test("role: exactly one of the six enum values", () => {
  for (const role of ["ADMIN", "ENGINEER", "DESIGNER", "REVIEWER", "APPROVER", "VIEWER"]) {
    assert.equal(parseRole(role), role);
  }
  for (const bad of ["admin", "OWNER", "", null, ["ADMIN"]]) {
    assert.throws(() => parseRole(bad), refusedWith("USER_ADMIN_ROLE_INVALID"));
  }
});

test("password: minimum characters, maximum 72 UTF-8 bytes, both entries equal", () => {
  const ok = "correct horse battery";
  assert.equal(validateNewPassword(ok, ok), ok);
  assert.throws(() => validateNewPassword("short-11ch!", "short-11ch!"), refusedWith("USER_ADMIN_PASSWORD_TOO_SHORT"));
  assert.throws(() => validateNewPassword(ok, `${ok} `), refusedWith("USER_ADMIN_PASSWORD_MISMATCH"));
  assert.throws(() => validateNewPassword(ok, undefined), refusedWith("USER_ADMIN_PASSWORD_MISMATCH"));
  assert.throws(() => validateNewPassword(undefined, undefined), refusedWith("USER_ADMIN_PASSWORD_TOO_SHORT"));
  const max = "x".repeat(MAX_PASSWORD_BYTES);
  assert.equal(validateNewPassword(max, max), max);
  const over = "€".repeat(25); // 25 characters, 75 bytes
  assert.throws(() => validateNewPassword(over, over), refusedWith("USER_ADMIN_PASSWORD_TOO_LONG"));
  const fifteen = "x".repeat(15);
  assert.throws(
    () => validateNewPassword(fifteen, fifteen, MIN_FIRST_ADMIN_PASSWORD_CHARS),
    refusedWith("USER_ADMIN_PASSWORD_TOO_SHORT"),
  );
});

test("password refusals never carry the submitted value", () => {
  const secret = "my-secret-value-1234";
  try {
    validateNewPassword(secret, "other-value-12345");
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof UserAdminRefusalError);
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
  }
});

test("authority: the actor must be among the locked active admins", () => {
  assertActorIsLockedAdmin("a1", ["a1", "a2"]);
  assert.throws(() => assertActorIsLockedAdmin("a3", ["a1", "a2"]), refusedWith("USER_ADMIN_NOT_ADMIN"));
  assert.throws(() => assertActorIsLockedAdmin("a1", []), refusedWith("USER_ADMIN_NOT_ADMIN"));
});

test("last active admin: removing the only one is refused; non-admins and other admins are fine", () => {
  assert.throws(() => assertNotLastActiveAdmin("a1", ["a1"]), refusedWith("USER_ADMIN_LAST_ADMIN"));
  assertNotLastActiveAdmin("a1", ["a1", "a2"]);
  assertNotLastActiveAdmin("u9", ["a1"]);
  try {
    assertNotLastActiveAdmin("a1", ["a1"]);
  } catch (error) {
    assert.ok(error instanceof UserAdminRefusalError);
    assert.equal(error.targetUserId, "a1");
  }
});

test("pwv: first 16 hex characters of sha256(passwordHash); null without a password", () => {
  const hash = "$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
  const expected = createHash("sha256").update(hash, "utf8").digest("hex").slice(0, 16);
  assert.equal(passwordVersion(hash), expected);
  assert.match(passwordVersion(hash)!, /^[0-9a-f]{16}$/);
  assert.equal(passwordVersion(null), null);
  assert.equal(passwordVersion(""), null);
  assert.notEqual(passwordVersion(hash), passwordVersion(`${hash}x`));
});

test("pwv match: current version only; a missing or malformed claim never matches", () => {
  const hash = "$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
  const pwv = passwordVersion(hash);
  assert.equal(passwordVersionMatches(pwv, hash), true);
  assert.equal(passwordVersionMatches(pwv, `${hash}x`), false, "after a reset");
  assert.equal(passwordVersionMatches(undefined, hash), false, "token from before B05");
  assert.equal(passwordVersionMatches(null, hash), false);
  assert.equal(passwordVersionMatches(pwv!.slice(0, 15), hash), false);
  assert.equal(passwordVersionMatches(123, hash), false);
  assert.equal(passwordVersionMatches(pwv, null), false, "user without a password");
});

test("log entry: allowlisted fields only - no email, name, password or hash", () => {
  const entry = buildUserAdminLogEntry(
    {
      action: "reset_password",
      outcome: "committed",
      code: null,
      actorUserId: "a1",
      organizationId: "o1",
      targetUserId: "u1",
      oldRole: null,
      newRole: null,
      oldActive: null,
      newActive: null,
      desktopSessionsRevoked: 2,
      // Extra properties smuggled in must not reach the log line.
      ...({ password: "leak", passwordHash: "leak", email: "leak@x.io", name: "Leak" } as object),
    },
    new Date("2026-11-20T10:00:00.000Z"),
  );
  assert.deepEqual(Object.keys(entry).sort(), [
    "action",
    "actorUserId",
    "at",
    "code",
    "desktopSessionsRevoked",
    "event",
    "newActive",
    "newRole",
    "oldActive",
    "oldRole",
    "organizationId",
    "outcome",
    "targetUserId",
  ]);
  assert.ok(!JSON.stringify(entry).includes("leak"));
  assert.equal(entry.event, "user_admin");
  assert.equal(entry.at, "2026-11-20T10:00:00.000Z");
});
