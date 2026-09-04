import { getActor } from "@/app/lib/authz";
import { getCheckoutHistoryHttpResult } from "@/app/lib/checkout-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cad-documents/:cadDocumentId/checkout/history?limit=20
 *
 * Bounded, newest-first checkout lifecycle history (CHECKED_OUT,
 * CHECKED_IN, UNDO_CHECKOUT, ADMIN_UNLOCK) for a CadDocument. `limit` is
 * clamped server-side to a small maximum regardless of what is requested -
 * never an unbounded query. Read-only; never mutates anything; never
 * exposes cross-tenant users or documents.
 *
 * Status codes: 401 unauthenticated, 404 cross-tenant/nonexistent document,
 * 200 success (possibly an empty list).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { cadDocumentId } = await ctx.params;
  const limit = new URL(request.url).searchParams.get("limit");

  const { status, body } = await getCheckoutHistoryHttpResult(actor, cadDocumentId, limit);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
