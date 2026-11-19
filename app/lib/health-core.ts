/**
 * Pilot server health check (A1 plan Step 11) - pure logic, no database or
 * Next.js imports, so it is unit-testable.
 *
 * Contract of GET /api/health:
 *  - LOOPBACK ONLY: answered only when the client addressed the server as a
 *    loopback host (the same Host-header judgement as the desktop transport
 *    guard, SEC-TLS-1). Anything else gets a bare 404, so the endpoint does not
 *    even reveal that it exists through the public TLS proxy. The monitor runs
 *    on the server itself (http://127.0.0.1:3000/api/health).
 *  - 200 {"status":"ok"} when a trivial database round trip answers within the
 *    timeout; otherwise 503 {"status":"unavailable"}.
 *  - Never any data, version, timing or error text; never cached.
 */
import { isLoopbackHostname, requestClientHostname } from "./desktop-auth-core.ts";

export const HEALTH_DB_TIMEOUT_MS = 2000;

export type HealthStatus = "ok" | "unavailable";

export interface HealthResult {
  httpStatus: 200 | 503;
  body: { status: HealthStatus };
}

/** True only when the client addressed this server as a loopback host. */
export function isHealthRequestAllowed(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  return isLoopbackHostname(requestClientHostname(request, env));
}

/**
 * Run the database ping with a hard timeout. Any failure - a rejected ping,
 * a ping that never settles, a timeout - is "unavailable"; the reason is
 * deliberately not reported.
 */
export async function evaluateHealth(
  ping: () => Promise<unknown>,
  timeoutMs: number = HEALTH_DB_TIMEOUT_MS,
): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(ping)
        .then(() => "ok" as const),
      timedOut,
    ]);
    if (outcome === "ok") {
      return { httpStatus: 200, body: { status: "ok" } };
    }
  } catch {
    // fall through: any error is "unavailable", without detail
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { httpStatus: 503, body: { status: "unavailable" } };
}

/**
 * Codex H-L1: SINGLE-FLIGHT. If the database hangs, a timed-out ping keeps a
 * pool connection until Prisma's own timeouts fire; repeated probes must not
 * pile up and drain the pool the application needs. While a ping is still in
 * flight, another check answers "unavailable" at once WITHOUT starting a new
 * ping. The flag clears when that ping SETTLES (not when the timeout fires).
 * Each checker has its own state; the route uses one module-level checker.
 */
export function createHealthChecker() {
  let inFlight = false;
  return async function check(
    ping: () => Promise<unknown>,
    timeoutMs: number = HEALTH_DB_TIMEOUT_MS,
  ): Promise<HealthResult> {
    if (inFlight) {
      return { httpStatus: 503, body: { status: "unavailable" } };
    }
    inFlight = true;
    const settled = Promise.resolve().then(ping);
    settled.then(
      () => {
        inFlight = false;
      },
      () => {
        inFlight = false;
      },
    );
    return evaluateHealth(() => settled, timeoutMs);
  };
}

/** Headers for every health response: never cached, never sniffed. */
export const HEALTH_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});
