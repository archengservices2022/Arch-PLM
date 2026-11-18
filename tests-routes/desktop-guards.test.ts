/**
 * WP-2B (2B-2): route-level tests for the guards in front of the CAD Connect
 * desktop data endpoints (WP-2A 2A-3 / 2A-4) and the shared file-content
 * endpoint. These call the REAL route handlers (app/api/** /route.ts) through
 * the test-only route loader - no Next.js server, no database: every case
 * here is refused before any database access.
 *
 * Run with:  npm run test:routes   (folder tests-routes/, kept out of the plain npm test glob)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface RouteCase {
  name: string;
  method: "GET" | "POST";
  path: string;
  modulePath: string;
  params?: Record<string, string>;
  body?: string;
}

const DESKTOP_DATA_ROUTES: RouteCase[] = [
  { name: "drawing-associations", method: "GET", path: "/api/desktop/cad-documents/drawing-associations?ids=doc1", modulePath: "../app/api/desktop/cad-documents/drawing-associations/route.ts" },
  { name: "latest-versions", method: "GET", path: "/api/desktop/cad-documents/latest-versions?ids=doc1", modulePath: "../app/api/desktop/cad-documents/latest-versions/route.ts" },
  { name: "resolve", method: "GET", path: "/api/desktop/cad-documents/resolve?documentNumber=P-100", modulePath: "../app/api/desktop/cad-documents/resolve/route.ts" },
  { name: "copy-design apply", method: "POST", path: "/api/desktop/copy-design/apply", modulePath: "../app/api/desktop/copy-design/apply/route.ts", body: "{}" },
  { name: "copy-design materialize", method: "POST", path: "/api/desktop/copy-design/materialize/doc1", modulePath: "../app/api/desktop/copy-design/materialize/[cadDocumentId]/route.ts", params: { cadDocumentId: "doc1" }, body: "x" },
  { name: "operation status", method: "GET", path: "/api/desktop/copy-design/operations/op1/status", modulePath: "../app/api/desktop/copy-design/operations/[operationId]/status/route.ts", params: { operationId: "op1" } },
  { name: "verification-support", method: "GET", path: "/api/desktop/copy-design/operations/op1/verification-support", modulePath: "../app/api/desktop/copy-design/operations/[operationId]/verification-support/route.ts", params: { operationId: "op1" } },
];

async function call(rc: RouteCase, origin: string, headers: Record<string, string>): Promise<Response> {
  const mod = (await import(rc.modulePath)) as Record<string, Handler>;
  const handler = mod[rc.method];
  assert.equal(typeof handler, "function", `${rc.name} exports ${rc.method}`);
  const init: RequestInit = { method: rc.method, headers: { ...headers } };
  if (rc.body !== undefined) {
    init.body = rc.body;
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const request = new Request(origin + rc.path, init);
  return handler(request, rc.params ? { params: Promise.resolve(rc.params) } : undefined);
}

// WP2B-L1: also assert the bearer-guard message, so a 401 from some other path
// (e.g. a cookie-auth fallback) cannot satisfy these cases by status alone.
const BEARER_GUARD_MESSAGE = /requires an Arch desktop bearer token/;

for (const rc of DESKTOP_DATA_ROUTES) {
  test(`${rc.name}: no credentials over loopback HTTP -> 401 (no browser-cookie fallback)`, async () => {
    const res = await call(rc, "http://127.0.0.1:3000", {});
    assert.equal(res.status, 401);
    assert.match(await res.text(), BEARER_GUARD_MESSAGE);
  });

  test(`${rc.name}: a browser session COOKIE alone -> 401 (2A-3)`, async () => {
    const res = await call(rc, "http://127.0.0.1:3000", { cookie: "authjs.session-token=browser-session" });
    assert.equal(res.status, 401);
    assert.match(await res.text(), BEARER_GUARD_MESSAGE);
  });

  test(`${rc.name}: a malformed Authorization header -> 401, never echoes the value`, async () => {
    const res = await call(rc, "http://127.0.0.1:3000", { authorization: "Basic c2VjcmV0LXZhbHVl" });
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes("c2VjcmV0LXZhbHVl"));
  });

  test(`${rc.name}: plain HTTP from a non-loopback host -> 400 before any credential check (2A-4)`, async () => {
    const res = await call(rc, "http://plm.example.com", { cookie: "authjs.session-token=browser-session" });
    assert.equal(res.status, 400);
  });

  test(`${rc.name}: HTTPS from a non-loopback host still requires the bearer -> 401`, async () => {
    const res = await call(rc, "https://plm.example.com", {});
    assert.equal(res.status, 401);
  });
}

test("file content (shared browser + add-in route): a malformed Authorization header -> 401, no cookie fallback", async () => {
  const mod = (await import("../app/api/file-versions/[fileVersionId]/content/route.ts")) as unknown as Record<string, Handler>;
  const res = await mod.GET!(
    new Request("http://127.0.0.1:3000/api/file-versions/fv1/content", { headers: { authorization: "Bearer not-an-arch-token" } }),
    { params: Promise.resolve({ fileVersionId: "fv1" }) },
  );
  assert.equal(res.status, 401);
});

test("file content: a bearer request over plain HTTP from a non-loopback host -> 400", async () => {
  const mod = (await import("../app/api/file-versions/[fileVersionId]/content/route.ts")) as unknown as Record<string, Handler>;
  const res = await mod.GET!(
    new Request("http://plm.example.com/api/file-versions/fv1/content", { headers: { authorization: "Bearer arch_dt_x" } }),
    { params: Promise.resolve({ fileVersionId: "fv1" }) },
  );
  assert.equal(res.status, 400);
});
