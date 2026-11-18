/**
 * Pilot UX fixes KI-1 / KI-2: unit tests for the pure refusal-notice logic
 * (`app/lib/action-notice-core.ts`).
 *
 * Covers: expected refusals become allowlisted notice codes; unexpected
 * errors and Next.js control flow (success redirects) are never caught;
 * notice codes from the URL are allowlisted; sign-in refusals are generic.
 *
 * Run with:  node --experimental-strip-types --test tests/action-notice-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CredentialsSignin, CallbackRouteError, AuthError } from "@auth/core/errors";

import {
  ACTION_REFUSAL_MESSAGES,
  ActionRefusalError,
  allNoticeCodes,
  classifyActionError,
  isCredentialsSignInError,
  isNextControlFlowError,
  isSignInErrorParam,
  noticeHref,
  noticeMessage,
  parseNoticeCode,
  refuseUnlessCanMutate,
  runRefusable,
  runSignInAttempt,
  SIGN_IN_ERROR_PARAM,
  SIGN_IN_FAILED_MESSAGE,
  SIGN_IN_REFUSED_HREF,
  type NoticeCode,
} from "../app/lib/action-notice-core.ts";
import {
  InvalidLifecycleCommentError,
  LIFECYCLE_DENIAL_MESSAGES,
  type LifecycleDenialCode,
} from "../app/lib/lifecycle-policy-core.ts";
import {
  LEGACY_REVALIDATION_MESSAGES,
  LegacyRevalidationError,
  type LegacyRevalidationCode,
} from "../app/lib/legacy-revalidation-core.ts";
import { LifecycleStateError } from "../app/lib/lifecycle-errors-core.ts";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** The shape of the error Next.js's redirect() throws (digest-tagged). */
function nextRedirectError(url = "/"): Error {
  return Object.assign(new Error("NEXT_REDIRECT"), {
    digest: `NEXT_REDIRECT;push;${url};303;`,
  });
}

/** release-db.ts's LifecyclePermissionError, by name + code (no DB import). */
class LifecyclePermissionErrorLike extends Error {
  readonly code: string;
  constructor(code: string, message = "refused") {
    super(message);
    this.name = "LifecyclePermissionError";
    this.code = code;
  }
}

// ------------------------------------------------------------
// classifyActionError: expected refusals -> allowlisted codes
// ------------------------------------------------------------

test("every B03 permission refusal code (and ACTOR_NOT_ACTIVE) maps to its fixed policy message", () => {
  const codes = [...(Object.keys(LIFECYCLE_DENIAL_MESSAGES) as LifecycleDenialCode[]), "ACTOR_NOT_ACTIVE"];
  for (const code of codes) {
    const notice = classifyActionError(new LifecyclePermissionErrorLike(code, "server-side text"));
    assert.equal(notice, `lifecycle.${code}`);
    const message = noticeMessage(notice!);
    if (code !== "ACTOR_NOT_ACTIVE") {
      assert.equal(message, LIFECYCLE_DENIAL_MESSAGES[code as LifecycleDenialCode]);
    }
    assert.ok(!message.includes("server-side text"), "the notice never echoes the error's own text");
  }
});

test("every Option A revalidation refusal code maps to its fixed message (reason required, revision Z, role, ...)", () => {
  for (const code of Object.keys(LEGACY_REVALIDATION_MESSAGES) as LegacyRevalidationCode[]) {
    const notice = classifyActionError(new LegacyRevalidationError(code));
    assert.equal(notice, `revalidation.${code}`);
    assert.equal(noticeMessage(notice!), LEGACY_REVALIDATION_MESSAGES[code]);
  }
  assert.equal(classifyActionError(new LegacyRevalidationError("REASON_REQUIRED")), "revalidation.REASON_REQUIRED");
  assert.equal(classifyActionError(new LegacyRevalidationError("REVISION_LIMIT")), "revalidation.REVISION_LIMIT");
});

test("lifecycle state refusals (stale form, terminal, not found, concurrent) map to fixed messages", () => {
  for (const code of ["REVISION_NOT_FOUND", "TERMINAL_REVISION", "INVALID_TRANSITION", "CONCURRENT_CHANGE", "RETRY_EXHAUSTED"] as const) {
    const notice = classifyActionError(new LifecycleStateError(code, "Invalid lifecycle transition: IN_REVIEW -> IN_REVIEW"));
    assert.equal(notice, `state.${code}`);
    assert.ok(!noticeMessage(notice!).includes("IN_REVIEW -> IN_REVIEW"), "no raw state text is shown");
  }
});

test("action refusals (KI-3 no target, Create next revision) map to their fixed messages", () => {
  for (const code of Object.keys(ACTION_REFUSAL_MESSAGES) as (keyof typeof ACTION_REFUSAL_MESSAGES)[]) {
    const notice = classifyActionError(new ActionRefusalError(code, "internal wording"));
    assert.equal(notice, `action.${code}`);
    assert.equal(noticeMessage(notice!), ACTION_REFUSAL_MESSAGES[code]);
  }
});

test("F-1: the typed create-next role refusal maps to its fixed message", () => {
  const notice = classifyActionError(
    new ActionRefusalError("CREATE_NEXT_ROLE_NOT_PERMITTED", "You do not have permission to perform this action."),
  );
  assert.equal(notice, "action.CREATE_NEXT_ROLE_NOT_PERMITTED");
  assert.equal(noticeMessage(notice!), "Your role does not allow creating new revisions.");
  assert.equal(parseNoticeCode("action.CREATE_NEXT_ROLE_NOT_PERMITTED"), "action.CREATE_NEXT_ROLE_NOT_PERMITTED");
});

test("F-1: plain errors are never classified by their message text (assertCanMutate's own error, sign-in error, look-alikes)", () => {
  for (const message of [
    "You do not have permission to perform this action.",
    "You must be signed in to perform this action.",
    "Your role does not allow creating new revisions.",
    "CREATE_NEXT_ROLE_NOT_PERMITTED",
    "action.CREATE_NEXT_ROLE_NOT_PERMITTED",
  ]) {
    assert.equal(classifyActionError(new Error(message)), null, message);
  }
  const renamed = new Error("You do not have permission to perform this action.");
  renamed.name = "ActionRefusalError"; // name alone is not enough: only real ActionRefusalError instances count
  assert.equal(classifyActionError(renamed), null);
  const fakeCode = Object.assign(new Error("x"), { name: "ActionRefusalError", code: "CREATE_NEXT_ROLE_NOT_PERMITTED" });
  assert.equal(classifyActionError(fakeCode), null);
});

test("SD-I1: refuseUnlessCanMutate(false) raises the typed role refusal; its notice has a fixed message", async () => {
  assert.doesNotThrow(() => refuseUnlessCanMutate(true));
  let caught: unknown;
  try {
    refuseUnlessCanMutate(false);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ActionRefusalError);
  assert.equal((caught as ActionRefusalError).code, "ROLE_NOT_PERMITTED");
  assert.equal((caught as Error).message, "You do not have permission to perform this action.", "server-side wording unchanged");

  const notice = classifyActionError(caught);
  assert.equal(notice, "action.ROLE_NOT_PERMITTED");
  assert.equal(noticeMessage(notice!), "Your role does not allow making changes. Ask an administrator if you need access.");
  assert.equal(parseNoticeCode("action.ROLE_NOT_PERMITTED"), "action.ROLE_NOT_PERMITTED");

  // Through runRefusable (what the Server Action wrapper uses): a notice, never a throw.
  assert.equal(await runRefusable(async () => refuseUnlessCanMutate(false)), "action.ROLE_NOT_PERMITTED");
  assert.equal(await runRefusable(async () => refuseUnlessCanMutate(true)), null);
});

test("SD-I1: plain errors with the role-refusal wording are still never classified", () => {
  for (const message of [
    "Your role does not allow making changes. Ask an administrator if you need access.",
    "ROLE_NOT_PERMITTED",
    "action.ROLE_NOT_PERMITTED",
  ]) {
    assert.equal(classifyActionError(new Error(message)), null, message);
  }
  const fakeCode = Object.assign(new Error("x"), { name: "ActionRefusalError", code: "ROLE_NOT_PERMITTED" });
  assert.equal(classifyActionError(fakeCode), null);
});

test("SD-I1 guard: every Server Action that calls assertCanMutate first refuses a non-write role with a typed notice", () => {
  // A regression tripwire, not a parser (SD-I1-L1): comments are stripped so a
  // commented-out call does not count; any role enforcement (assertCanMutate /
  // assertRole) must be preceded by a typed refusal; and arrow-function
  // exports are rejected outright so they cannot slip past the split.
  const source = readFileSync(new URL("../app/actions.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  assert.ok(!/\nexport const \w+\s*=\s*async/.test(source), "Server Actions must be `export async function` so this guard sees them");
  const bodies = source.split(/\nexport async function /).slice(1);
  const ENFORCE = /\b(assertCanMutate|assertRole)\(/;
  const mutating = bodies.filter((body) => ENFORCE.test(body));
  assert.ok(mutating.length >= 7, `expected the 7 mutating actions, found ${mutating.length}`);
  for (const body of mutating) {
    const name = body.slice(0, body.indexOf("("));
    const enforce = body.search(ENFORCE);
    const refuse = Math.max(
      body.indexOf("await refuseUnlessWriteRole(actor);"),
      body.indexOf('"CREATE_NEXT_ROLE_NOT_PERMITTED"'), // F-1's specific refusal (createEngineeringRevision)
    );
    assert.ok(refuse !== -1 && refuse < enforce, `${name}: typed role refusal must come before role enforcement`);
  }
});

test("an over-long comment or reason maps to one fixed message", () => {
  assert.equal(classifyActionError(new InvalidLifecycleCommentError("Comment must be 500 characters or fewer.")), "comment.INVALID");
});

// ------------------------------------------------------------
// classifyActionError: everything else is NOT a refusal
// ------------------------------------------------------------

test("unexpected errors are never classified: plain Error, database error, TypeError, non-Error values", () => {
  const prismaLike = Object.assign(new Error("Unique constraint failed"), { code: "P2002", name: "PrismaClientKnownRequestError" });
  for (const error of [new Error("boom"), prismaLike, new TypeError("x is undefined"), "string thrown", 42, null, undefined, { code: "REASON_REQUIRED" }]) {
    assert.equal(classifyActionError(error), null, `must not classify ${String(error)}`);
  }
});

test("a LifecyclePermissionError-named error with an unknown or missing code is NOT classified", () => {
  assert.equal(classifyActionError(new LifecyclePermissionErrorLike("SOMETHING_NEW")), null);
  const noCode = new Error("x");
  noCode.name = "LifecyclePermissionError";
  assert.equal(classifyActionError(noCode), null);
});

test("an error type with a code that is not on the allowlist is NOT classified", () => {
  const forged = new LegacyRevalidationError("NOT_FOUND");
  (forged as unknown as { code: string }).code = "../../etc";
  assert.equal(classifyActionError(forged), null);
});

test("Next.js control-flow errors (redirect, notFound, ...) are never classified, even when they look like a refusal", () => {
  const redirect = nextRedirectError();
  assert.equal(isNextControlFlowError(redirect), true);
  assert.equal(classifyActionError(redirect), null);
  for (const digest of ["NEXT_NOT_FOUND", "NEXT_HTTP_ERROR_FALLBACK;404", "DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING"]) {
    assert.equal(isNextControlFlowError(Object.assign(new Error(digest), { digest })), true);
  }
  // A redirect error that also carries a refusal-like shape still is NOT a refusal.
  const disguised = Object.assign(new LegacyRevalidationError("REASON_REQUIRED"), { digest: "NEXT_REDIRECT;push;/;303;" });
  assert.equal(classifyActionError(disguised), null);
  assert.equal(isNextControlFlowError(new Error("NEXT_REDIRECT")), false, "only the digest identifies control flow");
});

// ------------------------------------------------------------
// runRefusable: success, refusal, unexpected, redirect
// ------------------------------------------------------------

test("runRefusable: success resolves to null", async () => {
  let ran = false;
  assert.equal(await runRefusable(async () => { ran = true; }), null);
  assert.equal(ran, true);
});

test("runRefusable: an expected refusal resolves to its notice code", async () => {
  const code = await runRefusable(async () => { throw new LegacyRevalidationError("REASON_REQUIRED"); });
  assert.equal(code, "revalidation.REASON_REQUIRED");
});

test("runRefusable: an unexpected error is rethrown unchanged (same object)", async () => {
  const boom = new Error("database unavailable");
  await assert.rejects(() => runRefusable(async () => { throw boom; }), (e) => e === boom);
});

test("runRefusable: a Next.js redirect thrown by the action is rethrown, never turned into a notice", async () => {
  const redirect = nextRedirectError("/somewhere");
  await assert.rejects(() => runRefusable(async () => { throw redirect; }), (e) => e === redirect);
});

test("runRefusable: rethrowFramework runs first and can rethrow before classification", async () => {
  const seen: unknown[] = [];
  const marker = new LegacyRevalidationError("REASON_REQUIRED");
  await assert.rejects(
    () => runRefusable(async () => { throw marker; }, {
      rethrowFramework: (e) => { seen.push(e); throw e; },
    }),
    (e) => e === marker,
  );
  assert.deepEqual(seen, [marker]);
});

test("runRefusable: rethrowFramework that does not throw leaves classification in place", async () => {
  const code = await runRefusable(async () => { throw new ActionRefusalError("TARGET_STATE_REQUIRED"); }, {
    rethrowFramework: () => {},
  });
  assert.equal(code, "action.TARGET_STATE_REQUIRED");
});

// ------------------------------------------------------------
// Notice codes in the URL
// ------------------------------------------------------------

test("parseNoticeCode accepts exactly the allowlisted codes", () => {
  const codes = allNoticeCodes();
  assert.ok(codes.length > 20);
  for (const code of codes) assert.equal(parseNoticeCode(code), code);
});

test("parseNoticeCode ignores unknown, malformed, injected, array and non-string values", () => {
  for (const raw of [
    undefined, null, "", "x", "lifecycle.", "lifecycle.NOPE", "REASON_REQUIRED",
    "revalidation.REASON_REQUIRED ", " revalidation.REASON_REQUIRED", "REVALIDATION.REASON_REQUIRED",
    "<script>alert(1)</script>", "revalidation.REASON_REQUIRED<script>", "constructor", "__proto__", "toString",
    "hasOwnProperty", ["revalidation.REASON_REQUIRED"], ["a", "b"], 5, {}, "a".repeat(500),
  ]) {
    assert.equal(parseNoticeCode(raw), null, `must ignore ${JSON.stringify(raw)}`);
  }
});

test("noticeHref carries only the code, URL-encoded, to the dashboard", () => {
  const code = "revalidation.REASON_REQUIRED" as NoticeCode;
  assert.equal(noticeHref(code), "/?notice=revalidation.REASON_REQUIRED");
  for (const c of allNoticeCodes()) {
    const url = new URL(noticeHref(c), "http://x");
    assert.equal(url.pathname, "/");
    assert.equal(parseNoticeCode(url.searchParams.get("notice")), c, "round-trips through the URL");
  }
});

test("every allowlisted message is fixed, non-empty plain text", () => {
  for (const code of allNoticeCodes()) {
    const message = noticeMessage(code);
    assert.ok(message.length > 10 && message.length < 300, code);
    assert.ok(!/[<>]/.test(message), `${code} contains no markup`);
  }
});

// ------------------------------------------------------------
// KI-1: sign-in
// ------------------------------------------------------------

test("isCredentialsSignInError: true only for Auth.js CredentialsSignin", () => {
  assert.equal(isCredentialsSignInError(new CredentialsSignin()), true);
  assert.equal(isCredentialsSignInError(new CallbackRouteError("db down")), false, "a server failure during sign-in is NOT a credentials refusal");
  assert.equal(isCredentialsSignInError(new AuthError("config")), false);
  assert.equal(isCredentialsSignInError(new Error("CredentialsSignin")), false);
  assert.equal(isCredentialsSignInError({ type: "CredentialsSignin" }), false, "only real Error objects");
  assert.equal(isCredentialsSignInError(nextRedirectError("/")), false);
});

test("runSignInAttempt: refused credentials resolve to 'refused'", async () => {
  assert.equal(await runSignInAttempt(async () => { throw new CredentialsSignin(); }), "refused");
});

test("runSignInAttempt: a successful sign-in's redirect is rethrown unchanged (never treated as a refusal)", async () => {
  const success = nextRedirectError("/");
  await assert.rejects(() => runSignInAttempt(async () => { throw success; }), (e) => e === success);
  const seen: unknown[] = [];
  await assert.rejects(
    () => runSignInAttempt(async () => { throw success; }, { rethrowFramework: (e) => { seen.push(e); throw e; } }),
    (e) => e === success,
  );
  assert.deepEqual(seen, [success], "Next's unstable_rethrow sees the redirect first");
});

test("runSignInAttempt: other Auth.js errors and unexpected errors are rethrown unchanged", async () => {
  const callback = new CallbackRouteError("db down");
  await assert.rejects(() => runSignInAttempt(async () => { throw callback; }), (e) => e === callback);
  const boom = new Error("boom");
  await assert.rejects(() => runSignInAttempt(async () => { throw boom; }), (e) => e === boom);
});

test("runSignInAttempt: completion without throwing resolves to 'completed'", async () => {
  assert.equal(await runSignInAttempt(async () => undefined), "completed");
});

test("the login error parameter accepts only its single fixed value; the message is generic", () => {
  assert.equal(SIGN_IN_REFUSED_HREF, `/login?error=${SIGN_IN_ERROR_PARAM}`);
  assert.equal(isSignInErrorParam(SIGN_IN_ERROR_PARAM), true);
  for (const raw of [undefined, "", "CredentialsSignin", "Configuration", "signin ", ["signin"], "<b>x</b>"]) {
    assert.equal(isSignInErrorParam(raw), false, JSON.stringify(raw));
  }
  assert.equal(SIGN_IN_FAILED_MESSAGE, "Invalid email or password.");
});
