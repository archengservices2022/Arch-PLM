/**
 * WP-2A (2A-1): login throttling policy (`app/lib/login-throttle-core.ts`).
 * PO decision PD-2A-1/2: 5 failures within 15 minutes -> wait 1, 2, 4, 8,
 * then at most 15 minutes; success resets. Pure tests with an injected clock.
 *
 * Run with:  node --experimental-strip-types --test tests/login-throttle-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LOGIN_THROTTLE_POLICY,
  LoginThrottle,
  getSharedLoginThrottle,
  loginThrottleKey,
  type LoginThrottlePolicy,
} from "../app/lib/login-throttle-core.ts";

const MIN = 60_000;

function clock(start = Date.UTC(2026, 10, 18, 12, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function failTimes(th: LoginThrottle, key: string, n: number) {
  for (let i = 0; i < n; i += 1) th.recordFailure(key);
}

test("default policy is exactly the approved one: 5 failures / 15 min, 1 min first block, 15 min cap", () => {
  assert.equal(DEFAULT_LOGIN_THROTTLE_POLICY.maxFailures, 5);
  assert.equal(DEFAULT_LOGIN_THROTTLE_POLICY.windowMs, 15 * MIN);
  assert.equal(DEFAULT_LOGIN_THROTTLE_POLICY.baseBlockMs, 1 * MIN);
  assert.equal(DEFAULT_LOGIN_THROTTLE_POLICY.maxBlockMs, 15 * MIN);
  assert.ok(Object.isFrozen(DEFAULT_LOGIN_THROTTLE_POLICY));
});

test("4 failures are still allowed; the 5th failure blocks for 1 minute", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  failTimes(th, k, 4);
  assert.deepEqual(th.check(k), { allowed: true });
  th.recordFailure(k);
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 60 });
  c.advance(59_000);
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 1 });
  c.advance(1_000);
  assert.deepEqual(th.check(k), { allowed: true });
});

function backoffWaits(th: LoginThrottle, c: ReturnType<typeof clock>, k: string, rounds: number): number[] {
  const waits: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const d = th.check(k);
    if (d.allowed) break;
    waits.push(d.retryAfterSeconds);
    c.advance(d.retryAfterSeconds * 1000); // wait out the block, then fail again
    th.recordFailure(k);
  }
  return waits;
}

test("continued failures back off 1, 2, 4, 8 minutes within the 15-minute window", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  failTimes(th, k, 5);
  assert.deepEqual(backoffWaits(th, c, k, 10), [60, 120, 240, 480]);
  // After the 8-minute block the first 5 failures are older than 15 minutes and
  // no longer count: the account is allowed again but keeps its backoff level,
  // so the next 5th-in-window failure blocks for the 15-minute cap.
  assert.deepEqual(th.check(k), { allowed: true });
  failTimes(th, k, 1);
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 900 });
});

test("the block length never exceeds the 15-minute cap", () => {
  const c = clock();
  const th = new LoginThrottle({ ...DEFAULT_LOGIN_THROTTLE_POLICY, windowMs: 24 * 60 * MIN }, c.now);
  const k = loginThrottleKey("eng@orga.com");
  failTimes(th, k, 5);
  assert.deepEqual(backoffWaits(th, c, k, 6), [60, 120, 240, 480, 900, 900]);
});

test("a successful sign-in clears the record (counter and backoff level)", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  failTimes(th, k, 5);
  c.advance(MIN);
  th.recordSuccess(k);
  assert.deepEqual(th.check(k), { allowed: true });
  failTimes(th, k, 4);
  assert.deepEqual(th.check(k), { allowed: true }, "fresh count after success");
  th.recordFailure(k);
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 60 }, "backoff restarted at 1 minute");
});

test("failures older than the 15-minute window no longer count; a quiet window resets the backoff level", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  failTimes(th, k, 4);
  c.advance(15 * MIN + 1);
  failTimes(th, k, 4);
  assert.deepEqual(th.check(k), { allowed: true }, "only 4 failures inside the window");
  failTimes(th, k, 1);
  assert.equal(th.check(k).allowed, false);
  c.advance(16 * MIN); // block over, window quiet
  failTimes(th, k, 5);
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 60 }, "level reset: 1 minute again");
});

test("accounts are independent and the key is normalized (case / whitespace)", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now);
  failTimes(th, loginThrottleKey("  ENG@OrgA.com "), 5);
  assert.equal(th.check(loginThrottleKey("eng@orga.com")).allowed, false, "same account, different spelling");
  assert.equal(th.check(loginThrottleKey("other@orga.com")).allowed, true, "other account unaffected");
  assert.equal(loginThrottleKey(" A@B.example "), loginThrottleKey("a@b.example"));
});

test("N1: the key is fixed-size (SHA-256) and never contains the raw e-mail, even for a 1 MB 'e-mail'", () => {
  const key = loginThrottleKey("eng@orga.com");
  assert.match(key, /^login:[0-9a-f]{64}$/);
  assert.ok(!key.includes("eng@orga.com"));
  const huge = loginThrottleKey("x".repeat(1_000_000) + "@spam.example");
  assert.equal(huge.length, key.length, "same bounded size regardless of input length");
  assert.notEqual(huge, key);
});

test("H1: beginAttempt reserves synchronously - a burst of 50 parallel attempts admits only 5", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  const decisions = Array.from({ length: 50 }, () => th.beginAttempt(k));
  assert.equal(decisions.filter((d) => d.allowed).length, 5);
  assert.equal(decisions.filter((d) => !d.allowed).length, 45);
  for (let i = 0; i < 5; i += 1) th.recordFailure(k); // the 5 admitted attempts fail
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 60 });
});

test("H1: after a block ends only ONE attempt at a time is admitted; its failure doubles the wait", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  for (let i = 0; i < 5; i += 1) { assert.equal(th.beginAttempt(k).allowed, true); th.recordFailure(k); }
  c.advance(60_000);
  const burst = Array.from({ length: 20 }, () => th.beginAttempt(k));
  assert.equal(burst.filter((d) => d.allowed).length, 1, "one attempt in flight at a time after a block");
  th.recordFailure(k);
  assert.deepEqual(th.check(k), { allowed: false, retryAfterSeconds: 120 });
});

test("H1: settling - success frees the account, cancel releases a reservation without counting a failure", () => {
  const c = clock(); const th = new LoginThrottle(undefined, c.now); const k = loginThrottleKey("eng@orga.com");
  for (let i = 0; i < 5; i += 1) assert.equal(th.beginAttempt(k).allowed, true);
  assert.equal(th.beginAttempt(k).allowed, false, "limit reached by in-flight attempts");
  th.cancelAttempt(k);                               // e.g. a database error - no verdict
  assert.equal(th.beginAttempt(k).allowed, true, "the cancelled slot is free again");
  th.recordSuccess(k);                               // one attempt succeeds
  for (let i = 0; i < 4; i += 1) th.recordFailure(k); // the remaining 4 in-flight attempts fail
  assert.deepEqual(th.check(k), { allowed: true }, "success cleared the counter: 4 failures do not block");
});

test("H1: the failure list per account is capped (memory cannot grow with request volume)", () => {
  const c = clock(); const th = new LoginThrottle({ ...DEFAULT_LOGIN_THROTTLE_POLICY, windowMs: 24 * 60 * MIN }, c.now);
  const k = loginThrottleKey("eng@orga.com");
  for (let i = 0; i < 1000; i += 1) th.recordFailure(k);
  // Not directly observable; the cap shows as unchanged behaviour: still blocked with the capped backoff.
  const d = th.check(k);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.ok(d.retryAfterSeconds <= 900);
});

test("M1: a flood of other e-mail addresses cannot evict (reset) a victim with recent failures", () => {
  const c = clock();
  const policy: LoginThrottlePolicy = { ...DEFAULT_LOGIN_THROTTLE_POLICY, maxTrackedKeys: 3 };
  const th = new LoginThrottle(policy, c.now);
  const victim = loginThrottleKey("admin@orga.com");
  for (let i = 0; i < 4; i += 1) { th.beginAttempt(victim); th.recordFailure(victim); } // 4 guesses on the victim
  for (const spray of ["x1@spam.example", "x2@spam.example"]) { th.beginAttempt(loginThrottleKey(spray)); th.recordFailure(loginThrottleKey(spray)); }
  assert.equal(th.size, 3);
  // The table is full of live entries: a NEW account is refused (fail safe), nothing is evicted.
  assert.deepEqual(th.beginAttempt(loginThrottleKey("x3@spam.example")), { allowed: false, retryAfterSeconds: 60 });
  assert.equal(th.size, 3);
  // The victim's 4 failures survived: one more failure blocks it.
  assert.equal(th.beginAttempt(victim).allowed, true);
  th.recordFailure(victim);
  assert.deepEqual(th.check(victim), { allowed: false, retryAfterSeconds: 60 });
});

test("M1: only EXPIRED entries are evicted - after the window passes, new accounts are admitted again", () => {
  const c = clock();
  const th = new LoginThrottle({ ...DEFAULT_LOGIN_THROTTLE_POLICY, maxTrackedKeys: 2 }, c.now);
  for (const e of ["a@x.example", "b@x.example"]) { th.beginAttempt(loginThrottleKey(e)); th.recordFailure(loginThrottleKey(e)); }
  assert.equal(th.beginAttempt(loginThrottleKey("c@x.example")).allowed, false);
  c.advance(15 * MIN + 1);
  assert.equal(th.beginAttempt(loginThrottleKey("c@x.example")).allowed, true, "expired entries were evicted");
});

test("invalid policies are rejected", () => {
  for (const bad of [
    { ...DEFAULT_LOGIN_THROTTLE_POLICY, maxFailures: 0 },
    { ...DEFAULT_LOGIN_THROTTLE_POLICY, windowMs: 0 },
    { ...DEFAULT_LOGIN_THROTTLE_POLICY, baseBlockMs: 0 },
    { ...DEFAULT_LOGIN_THROTTLE_POLICY, maxBlockMs: 1 },
    { ...DEFAULT_LOGIN_THROTTLE_POLICY, maxTrackedKeys: 0 },
  ]) {
    assert.throws(() => new LoginThrottle(bad), /Invalid login throttle policy/);
  }
});

test("one process-wide shared instance (kept on globalThis, survives a second module instance)", async () => {
  const a = getSharedLoginThrottle();
  assert.equal(getSharedLoginThrottle(), a);
  const copy = await import(`../app/lib/login-throttle-core.ts?second-instance=${Date.now()}`);
  assert.equal(copy.getSharedLoginThrottle(), a, "a second copy of the module still returns the same throttle");
});
