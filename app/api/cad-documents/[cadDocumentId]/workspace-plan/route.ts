import { getActor } from "@/app/lib/authz";
import { getWorkspacePlanHttpResult } from "@/app/lib/workspace-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cad-documents/:cadDocumentId/workspace-plan
 *
 * Return the versioned Managed Workspace Plan contract (P3B-2A) for a root
 * CAD document, for a future Windows/Inventor CAD Connect client. Built
 * entirely FROM the existing authenticated, tenant-safe Get Latest manifest
 * (`/api/cad-documents/:id/get-latest`) - no new database/storage lookups.
 *
 * `cadDocumentId` and each entry's `version.fileVersionId` are the only
 * authoritative identities; `documentNumber`, `fileName` and the generated
 * workspace `placement` path are display-only. The generated placement path
 * is NOT an Inventor project-relative reference path - the schema does not
 * store one, and this endpoint invents none.
 *
 * Nothing here mutates ItemRevision, lifecycle, CadDocument, FileVersion or
 * CadDependency data, and it never streams or bundles bytes itself (bytes
 * are still fetched through the existing download endpoint each entry's
 * `version.contentPath` points at).
 *
 * Status codes: 401 unauthenticated, 404 root not found in the tenant, 422
 * dependency graph too large. A 200 response may still describe an
 * UNSAFE/incomplete plan (`safe: false` with a populated `problems` array) -
 * a required document is never silently dropped, overwritten or renamed.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { cadDocumentId } = await ctx.params;

  const { status, body } = await getWorkspacePlanHttpResult(
    actor,
    cadDocumentId,
  );

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
