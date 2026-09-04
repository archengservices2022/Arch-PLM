import { getActor } from "@/app/lib/authz";
import { getLatestManifestHttpResult } from "@/app/lib/get-latest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cad-documents/:cadDocumentId/get-latest
 *
 * Return the server-computed "Get Latest" package manifest for a root CAD
 * document: the root plus every required descendant CAD document (walked over
 * CadDependency edges), each resolved to its latest binary-backed FileVersion,
 * with a safe relative workspace path and deduplicated dependency information.
 *
 * The manifest references the EXISTING authenticated download endpoint
 * (`/api/file-versions/:id/content`) for bytes - it does not stream or bundle
 * any binary itself. Every lookup is scoped to the authenticated actor's
 * organization. Nothing here touches ItemRevision / lifecycle state; this is
 * "latest live version", not an engineering release baseline.
 *
 * Status codes: 401 unauthenticated, 404 root not found in the tenant, 422
 * dependency graph too large. A 200 response may still describe an INCOMPLETE
 * package (`complete: false` with a populated `problems` array) - a required
 * document is never silently dropped.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { cadDocumentId } = await ctx.params;

  const { status, body } = await getLatestManifestHttpResult(
    actor,
    cadDocumentId,
  );

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
