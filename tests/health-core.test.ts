/**
 * Pilot health check (A1 plan Step 11): unit tests for app/lib/health-core.ts.
 * Run with: node --experimental-strip-types --test tests/health-core.test.ts (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHealthChecker, evaluateHealth, HEALTH_RESPONSE_HEADERS, isHealthRequestAllowed } from "../app/lib/health-core.ts";

test("evaluateHealth: a database ping that answers gives 200 {status: ok}", async () => {
  const result = await evaluateHealth(async () => [{ "?column?": 1 }]);
  assert.deepEqual(result, { httpStatus: 200, body: { status: "ok" } });
});

test("evaluateHealth: a failing ping gives 503 {status: unavailable} and never reports why", async () => {
  const secret = "password authentication failed for user arch_app at 10.1.2.3";
  const result = await evaluateHealth(async () => {
    throw new Error(secret);
  });
  assert.deepEqual(result, { httpStatus: 503, body: { status: "unavailable" } });
  assert.ok(!JSON.stringify(result).includes("password"), "no error text in the result");
});

test("evaluateHealth: a ping that throws synchronously is also just 'unavailable'", async () => {
  const result = await evaluateHealth(() => {
    throw new Error("sync failure");
  });
  assert.equal(result.httpStatus, 503);
});

test("evaluateHealth: a ping that never answers times out as 'unavailable' (no hang)", async () => {
  const started = Date.now();
  const result = await evaluateHealth(() => new Promise(() => {}), 50);
  assert.deepEqual(result, { httpStatus: 503, body: { status: "unavailable" } });
  assert.ok(Date.now() - started < 2000, "returns promptly after the timeout");
});

test("isHealthRequestAllowed: only a client that addressed the server as loopback", () => {
  const at = (url: string, host?: string, env: NodeJS.ProcessEnv = {}) =>
    isHealthRequestAllowed(new Request(url, host === undefined ? {} : { headers: { host } }), env);
  // the on-server monitor
  assert.equal(at("http://127.0.0.1:3000/api/health", "127.0.0.1:3000"), true);
  assert.equal(at("http://127.0.0.1:3000/api/health", "localhost:3000"), true);
  assert.equal(at("http://127.0.0.1:3000/api/health", "[::1]:3000"), true);
  // anything through the public proxy or a remote name - refused (route answers 404)
  assert.equal(at("https://127.0.0.1:3000/api/health", "plm.example.com"), false);
  assert.equal(at("http://127.0.0.1:3000/api/health", "plm.example.com"), false);
  assert.equal(at("http://127.0.0.1:3000/api/health", "192.168.1.50:3000"), false);
  assert.equal(at("http://127.0.0.1:3000/api/health", "evil@127.0.0.1"), false);
  // no Host header: refused in production (fail-closed), URL used elsewhere
  assert.equal(at("http://127.0.0.1:3000/api/health", undefined, { NODE_ENV: "production" }), false);
  assert.equal(at("http://127.0.0.1:3000/api/health", undefined, {}), true);
});

test("single-flight (H-L1): while a ping is in flight, further checks answer 'unavailable' at once and start NO new ping", async () => {
  const check = createHealthChecker();
  let pings = 0;
  let release!: () => void;
  const hung = () => {
    pings += 1;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  // 1st check: the ping hangs, the check times out as unavailable - but the ping is STILL in flight.
  assert.equal((await check(hung, 30)).httpStatus, 503);
  // 2nd and 3rd checks while it hangs: immediately unavailable, no new ping started.
  const started = Date.now();
  assert.equal((await check(hung, 5000)).httpStatus, 503);
  assert.equal((await check(hung, 5000)).httpStatus, 503);
  assert.ok(Date.now() - started < 1000, "answered at once, not after the 5 s timeout");
  assert.equal(pings, 1, "no pile-up of database pings");
  // When the hung ping finally settles, the next check runs a new ping again.
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await check(async () => { pings += 1; }, 1000), { httpStatus: 200, body: { status: "ok" } });
  assert.equal(pings, 2);
});

test("single-flight (H-L1): a rejected or synchronously throwing ping also clears the flag", async () => {
  const check = createHealthChecker();
  assert.equal((await check(() => { throw new Error("x"); })).httpStatus, 503);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await check(async () => { throw new Error("y"); })).httpStatus, 503);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await check(async () => 1)).httpStatus, 200);
});

test("health responses are never cached", () => {
  assert.equal(HEALTH_RESPONSE_HEADERS["Cache-Control"], "no-store");
  assert.equal(HEALTH_RESPONSE_HEADERS["X-Content-Type-Options"], "nosniff");
});
