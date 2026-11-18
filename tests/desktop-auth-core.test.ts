/**
 * Focused tests for the desktop bearer-session core
 * (`app/lib/desktop-auth-core.ts`, P4A). Pure - no DB, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/desktop-auth-core.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DESKTOP_TOKEN_PREFIX,
  DEFAULT_DESKTOP_SESSION_TTL_HOURS,
  MAX_DESKTOP_SESSION_TTL_HOURS,
  MAX_DESKTOP_LOGIN_BODY_BYTES,
  DesktopAuthError,
  assertRequestTransportAllowed,
  assertTransportAllowed,
  evaluateDesktopSession,
  generateDesktopToken,
  hashDesktopToken,
  isLoopbackHostname,
  parseBearerToken,
  readBoundedJsonBody,
  resolveDesktopSessionTtlHours,
  sanitizeClientLabel,
} from "../app/lib/desktop-auth-core.ts";

test("generated token: Arch prefix, high entropy, stable hash, hash != token", () => {
  const a = generateDesktopToken();
  const b = generateDesktopToken();
  assert.ok(a.token.startsWith(DESKTOP_TOKEN_PREFIX));
  assert.ok(a.token.length > DESKTOP_TOKEN_PREFIX.length + 40);
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, hashDesktopToken(a.token));
  assert.notEqual(a.tokenHash, a.token);
  assert.match(a.tokenHash, /^[0-9a-f]{64}$/);
});

test("parseBearerToken: accepts a well-formed Arch bearer, rejects everything else", () => {
  const { token } = generateDesktopToken();
  assert.equal(parseBearerToken(`Bearer ${token}`), token);
  assert.equal(parseBearerToken(`Bearer\t${token}`), token);
  assert.equal(parseBearerToken(`  Bearer ${token}  `), token);

  assert.equal(parseBearerToken(null), null);
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken(""), null);
  assert.equal(parseBearerToken("Bearer"), null);
  assert.equal(parseBearerToken(`Basic ${token}`), null);
  assert.equal(parseBearerToken(`Bearer not-an-arch-token`), null);
  assert.equal(parseBearerToken(`Bearer ${DESKTOP_TOKEN_PREFIX}`), null);
  assert.equal(parseBearerToken(`Bearer a b`), null);
});

test("resolveDesktopSessionTtlHours: default, valid override, cap, and rejected values", () => {
  assert.equal(resolveDesktopSessionTtlHours({}), DEFAULT_DESKTOP_SESSION_TTL_HOURS);
  assert.equal(resolveDesktopSessionTtlHours({ DESKTOP_SESSION_TTL_HOURS: "48" }), 48);
  assert.equal(
    resolveDesktopSessionTtlHours({ DESKTOP_SESSION_TTL_HOURS: String(MAX_DESKTOP_SESSION_TTL_HOURS + 1) }),
    DEFAULT_DESKTOP_SESSION_TTL_HOURS,
  );
  for (const bad of ["0", "-3", "abc", "12.5", ""]) {
    assert.equal(
      resolveDesktopSessionTtlHours({ DESKTOP_SESSION_TTL_HOURS: bad }),
      DEFAULT_DESKTOP_SESSION_TTL_HOURS,
    );
  }
});

test("evaluateDesktopSession: ok / expired / revoked / unknown", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const future = new Date("2026-01-01T18:00:00Z");
  const past = new Date("2026-01-01T06:00:00Z");

  assert.deepEqual(
    evaluateDesktopSession({ createdAt: past, expiresAt: future, revokedAt: null }, now),
    { ok: true },
  );
  assert.deepEqual(
    evaluateDesktopSession({ createdAt: past, expiresAt: past, revokedAt: null }, now),
    { ok: false, reason: "expired" },
  );
  assert.deepEqual(
    evaluateDesktopSession({ createdAt: past, expiresAt: future, revokedAt: past }, now),
    { ok: false, reason: "revoked" },
  );
  assert.deepEqual(evaluateDesktopSession(null, now), { ok: false, reason: "unknown" });
});

test("assertTransportAllowed: HTTPS anywhere; plain HTTP ONLY to a loopback host", () => {
  // https to a remote host - allowed
  assert.doesNotThrow(() => assertTransportAllowed("https:", "plm.example.com"));
  // http to each of the three loopback forms - allowed
  assert.doesNotThrow(() => assertTransportAllowed("http:", "localhost"));
  assert.doesNotThrow(() => assertTransportAllowed("http:", "127.0.0.1"));
  assert.doesNotThrow(() => assertTransportAllowed("http:", "[::1]"));
  assert.doesNotThrow(() => assertTransportAllowed("http:", "::1"));

  // http to anything else - rejected, no exception, no env/config bypass
  for (const host of ["plm.example.com", "192.168.1.50", "10.0.0.5", "workstation-01", "127.0.0.2"]) {
    assert.throws(
      () => assertTransportAllowed("http:", host),
      (err: unknown) => {
        assert.ok(err instanceof DesktopAuthError);
        assert.equal(err.status, 400);
        assert.ok(!err.message.includes(host), "must not echo the host");
        return true;
      },
      `http://${host} must be rejected`,
    );
  }
});

test("no environment variable can loosen the transport policy", () => {
  const saved = { ...process.env };
  try {
    process.env.ARCH_ALLOW_INSECURE_DESKTOP_AUTH = "true";
    process.env.NODE_ENV = "development";
    // The signature takes no bypass argument and reads no env - a private LAN
    // host over http is still rejected.
    assert.throws(() => assertTransportAllowed("http:", "192.168.1.50"), DesktopAuthError);
    assert.throws(
      () => assertRequestTransportAllowed(new Request("http://192.168.1.50:3000/api/desktop/auth/login")),
      DesktopAuthError,
    );
  } finally {
    process.env = saved;
  }
});

test("assertRequestTransportAllowed: uses ONLY new URL(request.url) - forwarded headers are never trusted", () => {
  const spoofHeaders = [
    { "x-forwarded-proto": "https" },
    { "x-forwarded-host": "localhost" },
    { "x-forwarded-host": "127.0.0.1" },
    { "x-forwarded-proto": "https", "x-forwarded-host": "localhost" },
    { forwarded: "proto=https;host=localhost", "x-forwarded-proto": "https", "x-forwarded-host": "127.0.0.1" },
  ];

  // 1-4. remote HTTP + any/all spoofed forwarded headers => STILL rejected
  assert.throws(
    () => assertRequestTransportAllowed(new Request("http://plm.example.com/api/desktop/auth/login")),
    DesktopAuthError,
    "remote HTTP + no forwarded headers must be rejected",
  );
  for (const headers of spoofHeaders) {
    assert.throws(
      () => assertRequestTransportAllowed(new Request("http://plm.example.com/api/desktop/auth/login", { headers })),
      (err: unknown) => {
        assert.ok(err instanceof DesktopAuthError);
        assert.equal(err.status, 400);
        return true;
      },
      `remote HTTP must stay rejected despite ${JSON.stringify(headers)}`,
    );
  }
  // a spoofed forwarded-host also cannot smuggle a remote host through an
  // otherwise-loopback request in the other direction:
  assert.doesNotThrow(() =>
    assertRequestTransportAllowed(
      new Request("http://localhost:3000/api/desktop/session", {
        headers: { "x-forwarded-host": "plm.example.com", "x-forwarded-proto": "http" },
      }),
    ),
  );

  // 5. HTTPS remote => allowed
  assert.doesNotThrow(() =>
    assertRequestTransportAllowed(new Request("https://plm.example.com/api/desktop/auth/login")),
  );

  // 6-8. HTTP loopback => allowed
  for (const url of [
    "http://localhost:3000/api/desktop/auth/login",
    "http://127.0.0.1:3000/api/desktop/session",
    "http://[::1]:3000/api/desktop/auth/logout",
  ]) {
    assert.doesNotThrow(() => assertRequestTransportAllowed(new Request(url)), url);
  }
});

test("isLoopbackHostname: exactly localhost / 127.0.0.1 / ::1", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]", "  localhost  "]) {
    assert.equal(isLoopbackHostname(h), true, h);
  }
  for (const h of ["plm.example.com", "10.0.0.5", "192.168.0.1", "0.0.0.0", "127.0.0.2", "localhost.example.com"]) {
    assert.equal(isLoopbackHostname(h), false, h);
  }
});

// ------------------------------------------------------------
// Bounded login body
// ------------------------------------------------------------

function jsonRequest(body: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/desktop/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body,
  });
}

test("readBoundedJsonBody: a normal small body parses", async () => {
  const parsed = await readBoundedJsonBody(jsonRequest(JSON.stringify({ email: "a@b.com", password: "pw" })));
  assert.deepEqual(parsed, { email: "a@b.com", password: "pw" });
});

test("readBoundedJsonBody: a body near the limit still parses", async () => {
  const pad = "x".repeat(MAX_DESKTOP_LOGIN_BODY_BYTES - 64);
  const body = JSON.stringify({ email: "a@b.com", password: "pw", clientLabel: pad });
  assert.ok(body.length <= MAX_DESKTOP_LOGIN_BODY_BYTES);
  const parsed = (await readBoundedJsonBody(jsonRequest(body))) as { clientLabel: string };
  assert.equal(parsed.clientLabel.length, pad.length);
});

test("readBoundedJsonBody: an oversized Content-Length is rejected 413 before reading", async () => {
  const req = jsonRequest("{}", { "content-length": String(MAX_DESKTOP_LOGIN_BODY_BYTES + 1) });
  await assert.rejects(
    () => readBoundedJsonBody(req),
    (err: unknown) => err instanceof DesktopAuthError && err.status === 413,
  );
});

test("readBoundedJsonBody: an oversized streamed body is rejected 413 (never fully buffered)", async () => {
  const huge = JSON.stringify({ password: "p".repeat(MAX_DESKTOP_LOGIN_BODY_BYTES * 2) });
  // no content-length -> must be caught while streaming
  const req = new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(huge);
        for (let i = 0; i < bytes.length; i += 4096) {
          controller.enqueue(bytes.subarray(i, i + 4096));
        }
        controller.close();
      },
    }),
    // @ts-expect-error - Node requires duplex for a stream body
    duplex: "half",
  });
  await assert.rejects(
    () => readBoundedJsonBody(req),
    (err: unknown) => err instanceof DesktopAuthError && err.status === 413,
  );
});

test("readBoundedJsonBody: malformed JSON is a controlled 400 that never echoes the body", async () => {
  await assert.rejects(
    () => readBoundedJsonBody(jsonRequest("{not json, secret=hunter2")),
    (err: unknown) => {
      assert.ok(err instanceof DesktopAuthError);
      assert.equal(err.status, 400);
      assert.ok(!err.message.includes("hunter2"));
      return true;
    },
  );
});

test("readBoundedJsonBody: an empty body yields {} (-> downstream 400 for missing fields)", async () => {
  assert.deepEqual(await readBoundedJsonBody(jsonRequest("")), {});
});

test("sanitizeClientLabel: strips control chars, caps length, empties -> null", () => {
  assert.equal(sanitizeClientLabel(123), null);
  assert.equal(sanitizeClientLabel(null), null);
  assert.equal(sanitizeClientLabel("   "), null);
  assert.equal(sanitizeClientLabel("Inventor 2025 on WS-01"), "Inventor 2025 on WS-01");
  assert.equal(sanitizeClientLabel(String.fromCharCode(97, 9, 98, 7, 99, 127, 100)), "abcd", "tab/BEL/DEL dropped");
  assert.equal(sanitizeClientLabel("keeps interior spaces"), "keeps interior spaces");
  assert.equal(sanitizeClientLabel("x".repeat(500))!.length, 120);
  assert.equal(sanitizeClientLabel("  trimmed  "), "trimmed");
});

// ------------------------------------------------------------
// WP-2A (2A-3): /api/desktop/* data endpoints require a bearer token
// ------------------------------------------------------------

test("assertDesktopBearerPresent: no Authorization header (browser cookie request) -> 401; any Authorization header passes to bearer parsing", async () => {
  const { assertDesktopBearerPresent, DesktopAuthError: Err } = await import("../app/lib/desktop-auth-core.ts");
  const cookieOnly = new Request("http://127.0.0.1:3000/api/desktop/copy-design/apply", {
    method: "POST",
    headers: { cookie: "authjs.session-token=abc", "content-type": "application/json" },
  });
  assert.throws(() => assertDesktopBearerPresent(cookieOnly), (err: unknown) => {
    assert.ok(err instanceof Err);
    assert.equal(err.status, 401);
    return true;
  });
  const withBearer = new Request("http://127.0.0.1:3000/api/desktop/session", { headers: { authorization: "Bearer arch_dt_x" } });
  assert.doesNotThrow(() => assertDesktopBearerPresent(withBearer));
  // A malformed Authorization is NOT accepted here - it is passed on and rejected by parseBearerToken (401).
  const malformed = new Request("http://127.0.0.1:3000/api/desktop/session", { headers: { authorization: "Basic abc" } });
  assert.doesNotThrow(() => assertDesktopBearerPresent(malformed));
});
