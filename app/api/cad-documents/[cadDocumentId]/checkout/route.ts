import { getActor } from "@/app/lib/authz";
import {
  getCheckoutStatusHttpResult,
  requestCheckoutHttpResult,
} from "@/app/lib/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cad-documents/:cadDocumentId/checkout
 *
 * Authenticated, tenant-safe checkout STATUS for a CadDocument. Read-only -
 * never creates, changes, or removes anything.
 *
 * Body: `{ state: "available" }` or `{ state: "mine" | "locked", checkout }`.
 * Status codes: 401 unauthenticated, 404 cross-tenant/nonexistent document.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { cadDocumentId } = await ctx.params;

  const { status, body } = await getCheckoutStatusHttpResult(
    actor,
    cadDocumentId,
  );

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * POST /api/cad-documents/:cadDocumentId/checkout
 *
 * Request a server-authoritative, exclusive editing checkout of a
 * CadDocument. The checkout is captured against the document's exact current
 * newest binary-backed FileVersion - never re-resolved afterward, never
 * falling back to an older version if the newest one's bytes are missing.
 *
 * This milestone has NO check-in: a checkout, once created, is not released
 * by this API. Calling this again as the SAME actor is idempotent (returns
 * the existing checkout, 200); calling it while ANOTHER actor holds the
 * checkout fails with 409 and only tenant-safe lock information.
 *
 * Never creates a FileVersion, never touches ItemRevision/lifecycle, never
 * touches CadDependency, never mutates a stored binary.
 *
 * Status codes: 401 unauthenticated, 403 role cannot check out (VIEWER),
 * 404 cross-tenant/nonexistent document, 422 no valid binary-backed
 * FileVersion to lock against, 409 checked out by another actor,
 * 201 created, 200 idempotent (already held by this actor).
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { cadDocumentId } = await ctx.params;

  const { status, body } = await requestCheckoutHttpResult(
    actor,
    cadDocumentId,
  );

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
