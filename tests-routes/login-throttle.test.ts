/**
 * WP-2B (2B-2): route-level tests for POST /api/desktop/auth/login - the
 * real route handler through the test-only route loader, no database. The
 * login throttle refuses BEFORE any database lookup or password check, so the
 * 429 + Retry-After mapping (WP-2A 2A-1) is testable here.
 *
 * Run with:  npm run test:routes   (folder tests-routes/, kept out of the plain npm test glob)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getSharedLoginThrottle, loginThrottleKey } from "../app/lib/login-throttle-core.ts";

type Handler = (request: Request) => Promise<Response>;

async function login(origin: string, init: RequestInit): Promise<Response> {
  const mod = (await import("../app/api/desktop/auth/login/route.ts")) as unknown as Record<string, Handler>;
  return mod.POST!(new Request(origin + "/api/desktop/auth/login", { method: "POST", ...init }));
}

function lockAccount(email: string) {
  const throttle = getSharedLoginThrottle();
  const key = loginThrottleKey(email);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(throttle.beginAttempt(key).allowed, true);
    throttle.recordFailure(key);
  }
}

test("locked account -> 429 with Retry-After, generic message, no token - even with a password", async () => {
  lockAccount("locked-route@itest.example");
  const res = await login("http://127.0.0.1:3000", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "Locked-Route@itest.example", password: "any-password", clientLabel: "route-test" }),
  });
  assert.equal(res.status, 429);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After=${res.headers.get("retry-after")}`);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = await res.text();
  assert.ok(!body.includes("arch_dt_"), "no token issued");
  assert.ok(!body.toLowerCase().includes("locked-route@itest.example"), "message does not echo the account");
  assert.match(body, /Too many failed sign-in attempts/);
});

test("the shared throttle instance is the one the route uses (same globalThis instance)", async () => {
  // WP2B-L2: lock a second account through the shared instance obtained in the
  // test (getSharedLoginThrottle). The route refusing it with 429 proves the
  // route uses that same globalThis instance. (Proving an UNlocked account is
  // let through would need a database, so it is out of scope here.)
  lockAccount("second-route@itest.example");
  const res = await login("http://127.0.0.1:3000", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "second-route@itest.example", password: "x" }),
  });
  assert.equal(res.status, 429);
});

test("non-JSON content type -> 415 (before any credential handling)", async () => {
  const res = await login("http://127.0.0.1:3000", { headers: { "content-type": "text/plain" }, body: "email=a&password=b" });
  assert.equal(res.status, 415);
});

test("plain HTTP from a non-loopback host -> 400 (transport policy checked first)", async () => {
  const res = await login("http://plm.example.com", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.example", password: "x" }),
  });
  assert.equal(res.status, 400);
});
