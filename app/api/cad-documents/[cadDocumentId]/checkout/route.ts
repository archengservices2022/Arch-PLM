import type { Actor } from "@/app/lib/authz";
import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import {
  getCheckoutStatusHttpResult,
  requestCheckoutHttpResult,
} from "@/app/lib/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTH (P4C): accepts EITHER the browser NextAuth cookie (unchanged) OR a P4A
 * desktop bearer token (`Authorization: Bearer arch_dt_...`). A bearer request
 * must also satisfy the transport policy (HTTPS unless loopback). Tenant +
 * role are always re-derived server-side; VIEWER is rejected (403) and
 * cross-tenant is 404 exactly as before. No change to the P3C checkout
 * concurrency model, storage, FileVersion, or audit behaviour.
 */
async function resolveActorOrError(
  request: Request,
): Promise<{ actor: Actor | null } | { response: Response }> {
  try {
    return { actor: await resolveApiActor(request) };
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return {
        response: Response.json(
          { error: error.publicMessage },
          { status: error.status },
        ),
      };
    }
    throw error;
  }
}

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
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const resolved = await resolveActorOrError(request);
  if ("response" in resolved) return resolved.response;
  const { cadDocumentId } = await ctx.params;

  const { status, body } = await getCheckoutStatusHttpResult(
    resolved.actor,
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
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const resolved = await resolveActorOrError(request);
  if ("response" in resolved) return resolved.response;
  const { cadDocumentId } = await ctx.params;

  const { status, body } = await requestCheckoutHttpResult(
    resolved.actor,
    cadDocumentId,
  );

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
