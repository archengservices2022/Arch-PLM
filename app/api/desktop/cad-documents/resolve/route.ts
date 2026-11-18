import type { Actor } from "@/app/lib/authz";
import { DesktopAuthError, resolveDesktopApiActor } from "@/app/lib/api-actor";
import { assertRequestTransportAllowed } from "@/app/lib/desktop-auth-core";
import { desktopResolveHttpResult } from "@/app/lib/desktop-cad-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desktop/cad-documents/resolve?documentNumber=<n>[&documentType=<t>]
 *                                    | ?cadDocumentId=<id>
 *
 * The Inventor CAD Connect client's bootstrap lookup before a Get Latest:
 * resolve a tenant document number (or re-validate a stored cadDocumentId)
 * to its authoritative `{ cadDocumentId, documentNumber, fileName, cadType }`.
 *
 * P6D ROUND 2, HIGH fix: `documentNumber` is no longer unique by itself (a
 * model and its drawing may now legitimately share one engineering number,
 * distinguished by `documentType`) - the optional `documentType` query
 * param disambiguates. Omitting it when more than one document shares the
 * number is now a 409 (ambiguous), never a silent arbitrary pick.
 * `documentType` is rejected (400) alongside `cadDocumentId`, which is
 * already unambiguous on its own.
 *
 * Bearer-authenticated (P4A desktop session), tenant-scoped, VIEWER-ok,
 * read-only. A cross-tenant / unknown value is 404 (never leaked). Requires
 * the transport policy (HTTPS unless loopback) - this is a desktop-only
 * endpoint, no browser uses it.
 *
 * Status: 400 disallowed transport / malformed query, 401 no session,
 * 404 no match, 409 ambiguous number-only match, 200 with the resolved DTO.
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

  let actor: Actor | null;
  try {
    actor = await resolveDesktopApiActor(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const params = new URL(request.url).searchParams;
  const { status, body } = await desktopResolveHttpResult(actor, params);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
