import type { Actor } from "@/app/lib/authz";
import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import { getWorkspacePlanHttpResult } from "@/app/lib/workspace-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cad-documents/:cadDocumentId/workspace-plan
 *
 * Return the versioned Managed Workspace Plan contract (P3B-2A) for a root
 * CAD document, for the Windows/Inventor CAD Connect client. Built entirely
 * FROM the existing authenticated, tenant-safe Get Latest manifest
 * (`/api/cad-documents/:id/get-latest`) - no new database/storage lookups.
 *
 * AUTH (P4B): accepts EITHER the browser NextAuth cookie (unchanged) OR a
 * P4A desktop bearer token (`Authorization: Bearer arch_dt_...`). A bearer
 * request must also satisfy the transport policy (HTTPS unless loopback).
 * The tenant and role are always re-derived server-side from the verified
 * session; reads are VIEWER-compatible and strictly organization-scoped.
 *
 * `cadDocumentId` and each entry's `version.fileVersionId` are the only
 * authoritative identities; `documentNumber`, `fileName` and the generated
 * workspace `placement` path are display-only. The generated placement path
 * is NOT an Inventor project-relative reference path.
 *
 * Nothing here mutates ItemRevision, lifecycle, CadDocument, FileVersion or
 * CadDependency data, and it never streams or bundles bytes itself.
 *
 * Status codes: 400 disallowed transport (bearer only), 401 unauthenticated,
 * 404 root not found in the tenant, 422 dependency graph too large. A 200
 * response may still describe an UNSAFE/incomplete plan (`safe: false` with
 * a populated `problems` array) - a required document is never silently
 * dropped, overwritten or renamed.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const { cadDocumentId } = await ctx.params;

  let actor: Actor | null;
  try {
    actor = await resolveApiActor(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const { status, body } = await getWorkspacePlanHttpResult(actor, cadDocumentId);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
