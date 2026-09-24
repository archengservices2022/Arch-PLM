import type { Actor } from "@/app/lib/authz";
import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import { assertRequestTransportAllowed } from "@/app/lib/desktop-auth-core";
import { desktopDrawingAssociationsHttpResult } from "@/app/lib/desktop-drawing-associations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desktop/cad-documents/drawing-associations
 *       ?cadDocumentId=<id>&cadDocumentId=<id>...
 *
 * P6D DRAWING ASSOCIATION AUTHORITY: the CAD Connect client's Copy Design
 * Preview authoritative "which drawing(s) belong to this model?" lookup, for
 * a batch of EXACT stable model `cadDocumentId`s it already holds (from a
 * verified workspace manifest / resolve). Answers from the `CadDependency`
 * graph ONLY - `dependencyType = "DRAWING_REFERENCE"` rows where the
 * requested id is the `childDocument` (the model) - never from a file name.
 *
 * Bearer-authenticated (P4A desktop session), tenant-scoped, VIEWER-ok,
 * strictly READ-ONLY (no mutation). A cross-tenant / unknown id is
 * `recognized: false` - never leaked. Requires the desktop transport policy
 * (HTTPS unless loopback) - this is a desktop-only endpoint, no browser uses
 * it.
 *
 * `recognized: true` with an EMPTY `drawings` array is a legitimate, distinct
 * answer ("this model has no drawing") from `recognized: false` (the id
 * itself could not be confirmed) - the client's planner treats these very
 * differently (Found vs NotAvailable) and this endpoint must never blur them.
 *
 * Status: 400 disallowed transport / malformed / unbounded query, 401 no or
 * invalid session, 200 with the `arch-plm.desktop-drawing-associations.v1`
 * DTO.
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
    actor = await resolveApiActor(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const params = new URL(request.url).searchParams;
  const { status, body } = await desktopDrawingAssociationsHttpResult(actor, params);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
