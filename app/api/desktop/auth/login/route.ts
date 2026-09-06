import {
  authenticateDesktopClient,
  DesktopAuthError,
} from "@/app/lib/desktop-auth";
import {
  assertRequestTransportAllowed,
  MAX_DESKTOP_LOGIN_BODY_BYTES,
  readBoundedJsonBody,
} from "@/app/lib/desktop-auth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/desktop/auth/login
 *
 * Exchange email + password for an opaque, expiring bearer token used by the
 * Autodesk Inventor "Arch Engineering" CAD Connect add-in (P4A). The browser
 * dashboard is unaffected - it keeps using NextAuth cookies.
 *
 * Request body (JSON, <= 16 KB): { email, password, clientLabel? }
 * Response 200 (JSON): DesktopLoginResponseDto - the raw token is returned
 *   ONCE here and never again.
 *
 * Status codes: 400 malformed JSON; 401 bad credentials (generic - never
 * says which part failed); 413 body too large; 415 non-JSON content-type;
 * and 400 for a non-HTTPS non-loopback request (transport policy - checked
 * BEFORE the body is read). organizationId / userId are derived server-side
 * from the verified user and are never read from the request.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertRequestTransportAllowed(request);

    if (!request.headers.get("content-type")?.includes("application/json")) {
      return Response.json(
        { error: "Request body must be application/json." },
        { status: 415 },
      );
    }

    const body = await readBoundedJsonBody(request, MAX_DESKTOP_LOGIN_BODY_BYTES);
    const { email, password, clientLabel } = (body ?? {}) as Record<string, unknown>;

    const result = await authenticateDesktopClient(email, password, clientLabel);
    return Response.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    // Never leak an unexpected server error's detail to a desktop client.
    return Response.json({ error: "Sign-in is temporarily unavailable." }, { status: 500 });
  }
}
