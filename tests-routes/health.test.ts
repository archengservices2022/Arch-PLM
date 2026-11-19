/**
 * Pilot health check (A1 plan Step 11): the REAL route handler refuses anyone
 * who did not address the server as loopback, with a bare 404 that reveals
 * nothing. (The database path is covered by tests/health-core.test.ts with a
 * fake ping - CI has no database, and a pending connection must not hang the run.)
 *
 * Run with: npm run test:routes
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type Handler = (request: Request) => Promise<Response>;

async function getHealth(url: string, host: string): Promise<Response> {
  const mod = (await import("../app/api/health/route.ts")) as unknown as Record<string, Handler>;
  return mod.GET(new Request(url, { headers: { host } }));
}

test("GET /api/health through the public proxy (Host = public name, https) -> bare 404", async () => {
  const res = await getHealth("https://127.0.0.1:3000/api/health", "plm.example.com");
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "", "the 404 body is empty - the endpoint does not reveal itself");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("GET /api/health from a remote client over plain HTTP -> bare 404", async () => {
  for (const host of ["plm.example.com", "192.168.1.50:3000", "evil@127.0.0.1"]) {
    const res = await getHealth("http://127.0.0.1:3000/api/health", host);
    assert.equal(res.status, 404, host);
    assert.equal(await res.text(), "", host);
  }
});
