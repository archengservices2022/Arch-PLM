import { revokeDesktopSession } from "@/app/lib/desktop-auth";
import {
  assertRequestTransportAllowed,
  DesktopAuthError,
  parseBearerToken,
} from "@/app/lib/desktop-auth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/desktop/auth/logout
 *
 * Revoke the caller's desktop bearer session server-side (`DesktopSession.
 * revokedAt`). Idempotent: a missing / malformed / unknown / already-revoked
 * token is 200 `{ revoked: false }` (the client clears its local session
 * regardless). `{ revoked: true }` means this call invalidated a live
 * session. A non-HTTPS non-loopback request is still refused (400) - the
 * same transport policy every desktop endpoint enforces; the C# client
 * treats that failure as "clear locally anyway".
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertRequestTransportAllowed(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const token = parseBearerToken(request.headers.get("authorization"));
  const outcome = token ? await revokeDesktopSession(token) : { revoked: false };
  return Response.json(outcome, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}
