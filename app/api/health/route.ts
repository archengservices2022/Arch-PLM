import { prisma } from "@/app/lib/prisma";
import {
  createHealthChecker,
  HEALTH_RESPONSE_HEADERS,
  isHealthRequestAllowed,
} from "@/app/lib/health-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One single-flight checker per server process (Codex H-L1). */
const checkHealth = createHealthChecker();

/**
 * GET /api/health - local liveness + database check for the pilot server's
 * monitor (A1 plan Step 11). Loopback only (404 otherwise); returns
 * {"status":"ok"} (200) or {"status":"unavailable"} (503) and nothing else.
 * See app/lib/health-core.ts for the full contract.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isHealthRequestAllowed(request)) {
    return new Response(null, { status: 404, headers: HEALTH_RESPONSE_HEADERS });
  }
  const result = await checkHealth(() => prisma.$queryRaw`SELECT 1`);
  return Response.json(result.body, { status: result.httpStatus, headers: HEALTH_RESPONSE_HEADERS });
}
