import {
  desktopSessionResponse,
  resolveDesktopSession,
} from "@/app/lib/desktop-auth";
import {
  assertRequestTransportAllowed,
  DesktopAuthError,
  parseBearerToken,
} from "@/app/lib/desktop-auth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desktop/session
 *
 * The desktop client's "who am I / is the server reachable" probe. With a
 * valid `Authorization: Bearer arch_dt_...` header it returns the current
 * identity, session timing, and server clock (DesktopSessionResponseDto).
 * Any invalid/absent token is a flat 401 with a generic message - the
 * response never says whether the token was unknown, expired or revoked.
 *
 * This is also what the ribbon "Server Status" button calls: a 200 means
 * "connected", 401 means "sign in again", a transport error means "server
 * unavailable".
 */
export async function GET(request: Request): Promise<Response> {
  try {
    assertRequestTransportAllowed(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const token = parseBearerToken(request.headers.get("authorization"));
  if (token === null) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const resolved = await resolveDesktopSession(token);
  if (!resolved) {
    return Response.json(
      { error: "Your session is no longer valid. Sign in again." },
      { status: 401 },
    );
  }

  return Response.json(desktopSessionResponse(resolved), {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}
