import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import { undoCheckoutHttpResult } from "@/app/lib/checkout-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generous relative to the 1000-char reason cap enforced in
 *  checkout-release-core.ts - just a cheap guard against a huge arbitrary
 *  JSON payload before it is ever parsed. */
const MAX_BODY_BYTES = 10_000;

async function readOptionalReason(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return undefined;
  }
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "reason" in parsed) {
      return (parsed as { reason: unknown }).reason;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/cad-documents/:cadDocumentId/checkout/undo
 *
 * The checkout's OWNER voluntarily releases their own active checkout.
 * Optional JSON body: `{ "reason": "..." }` (trimmed, capped, never
 * required). Never creates a FileVersion, never touches stored binaries,
 * never mutates ItemRevision/lifecycle. Records a durable UNDO_CHECKOUT
 * audit event atomically with the checkout removal - see
 * `app/lib/checkout-release-db.ts`.
 *
 * AUTH (P4C): accepts EITHER the browser NextAuth cookie (unchanged) OR a
 * P4A desktop bearer token; a bearer request must also satisfy the transport
 * policy. Tenant + role/ownership are re-derived server-side. No change to
 * the P3C release concurrency or audit model; admin-unlock / history stay
 * cookie-only.
 *
 * Status codes: 400 disallowed transport (bearer only), 401 unauthenticated,
 * 403 role/ownership forbidden, 404 cross-tenant/nonexistent document,
 * 409 no active checkout / lost a concurrent race, 200 success.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  let actor;
  try {
    actor = await resolveApiActor(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }
  const { cadDocumentId } = await ctx.params;
  const reason = await readOptionalReason(request);

  const { status, body } = await undoCheckoutHttpResult(actor, cadDocumentId, reason);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
