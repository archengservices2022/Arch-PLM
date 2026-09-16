import type { Actor } from "@/app/lib/authz";
import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import {
  assertRequestTransportAllowed,
  readBoundedJsonBody,
} from "@/app/lib/desktop-auth-core";
import {
  isStrictJsonContentType,
  MAX_COPY_DESIGN_APPLY_BODY_BYTES,
} from "@/app/lib/copy-design-lineage-core";
import { copyDesignApplyHttpResult } from "@/app/lib/copy-design-lineage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/desktop/copy-design/apply
 *
 * Reserve the server-side PLM identities + immutable lineage for ONE
 * confirmed Arch CAD Connect P6A "Copy Design" plan (P6B). For every COPY
 * entry this creates a brand-new CadDocument identity and exactly one
 * CadCopyLineage row naming its exact source CadDocument + source
 * FileVersion; every REUSE entry is validated (tenant-scoped) and returned
 * as-is, creating nothing.
 *
 * THIS ENDPOINT NEVER TOUCHES A PHYSICAL CAD FILE: no upload, no download,
 * no FileVersion is created, no Inventor operation of any kind is performed
 * (no SaveAs, no ReplaceReference, no drawing copy, no Mirror, no
 * Pack & Go, no PDF/DXF/STEP export). That remains P6C and later.
 *
 * Bearer (P4A desktop session) OR NextAuth cookie authenticated, tenant-
 * scoped, requires the SAME mutation floor as managed CAD creation
 * (`assertCanMutate`'s role set - VIEWER is rejected). Requires the desktop
 * transport policy (HTTPS unless loopback) exactly like every other desktop
 * route.
 *
 * Request body (JSON, <= 256 KB):
 *   {
 *     idempotencyKey: string,      // client-generated opaque token
 *     label?: string,              // optional, display-only
 *     entries: Array<
 *       | { action: "COPY", sourceCadDocumentId, sourceFileVersionId,
 *           newDocumentNumber, newFileName, documentType, description? }
 *       | { action: "REUSE", cadDocumentId }
 *     >
 *   }
 * organizationId / performedById / copiedById are NEVER read from the
 * request - they come only from the verified actor.
 *
 * Response 200 (JSON): { contract, copyDesignOperationId, performedAt,
 *   entries: [{ action, sourceCadDocumentId?, sourceFileVersionId?,
 *     resultingCadDocumentId, documentNumber, fileName, documentType }] }
 * Retrying with the SAME idempotencyKey and an equivalent request replays
 * this SAME response and creates nothing new; the same key with a
 * materially different request is rejected (409).
 *
 * Status codes: 400 disallowed transport / malformed JSON / malformed
 * request shape; 401 no or invalid session; 403 role does not permit
 * mutation; 404 a referenced source/reuse CAD document or FileVersion does
 * not exist in the actor's organization (also how cross-tenant access
 * surfaces - never distinguished); 409 destination documentNumber collision,
 * idempotency-key reused for a different request, or a concurrency conflict;
 * 413 body too large; 415 non-JSON content-type.
 */
export async function POST(request: Request): Promise<Response> {
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

  if (!isStrictJsonContentType(request.headers.get("content-type"))) {
    return Response.json(
      { error: "Request body must be application/json." },
      { status: 415 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await readBoundedJsonBody(request, MAX_COPY_DESIGN_APPLY_BODY_BYTES);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const { status, body } = await copyDesignApplyHttpResult(actor, rawBody);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
