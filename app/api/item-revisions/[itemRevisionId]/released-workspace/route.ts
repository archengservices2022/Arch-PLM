import { getActor } from "@/app/lib/authz";
import { getReleasedWorkspaceHttpResult } from "@/app/lib/released-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/item-revisions/:itemRevisionId/released-workspace
 *
 * Return the versioned Released Workspace Plan contract (P3D-2) for a
 * RELEASED ItemRevision, built EXCLUSIVELY from the immutable P3D-1
 * ReleaseBaseline - never from "current"/Get-Latest resolution. Later
 * FileVersions on the same CadDocuments are never substituted.
 *
 * Read-only: never mutates ItemRevision, ReleaseBaseline, or
 * ReleaseBaselineEntry. Never repairs a missing/incomplete baseline.
 *
 * Authorization: any authenticated actor may read released engineering data
 * (no write-role gate - the same read policy as Get Latest / workspace-plan
 * / checkout status/history), including VIEWER.
 *
 * Status codes: 401 unauthenticated; 404 revision not found / cross-tenant;
 * 409 revision exists but is not RELEASED; 422 the frozen baseline itself
 * is missing or a pinned entry fails integrity verification (a permanent
 * data problem, not a retryable conflict) - see
 * `app/lib/released-workspace-db.ts` for the exact mapping rationale.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ itemRevisionId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { itemRevisionId } = await ctx.params;

  const { status, body } = await getReleasedWorkspaceHttpResult(actor, itemRevisionId);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
