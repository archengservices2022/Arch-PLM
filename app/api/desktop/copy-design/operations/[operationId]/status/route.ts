import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import { assertRequestTransportAllowed } from "@/app/lib/desktop-auth-core";
import { CopyDesignOperationStatusValidationError, parseOperationId } from "@/app/lib/copy-design-operation-status-core";
import { copyDesignOperationStatusHttpResult } from "@/app/lib/copy-design-operation-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desktop/copy-design/operations/:operationId/status
 *
 * P6D ROUND 3, HIGH fix (item D): the authoritative, dedicated, READ-ONLY
 * status of ONE Copy Design operation the caller already knows the id of -
 * every immutable `CopyDesignOperationEntry` this operation decided, plus an
 * EXPLICIT server-derived state per entry:
 *
 *   REUSE entry -> "REUSED" (no materialization expected, ever).
 *   COPY entry  -> "PENDING" (reserved, zero FileVersion rows yet),
 *                  "MATERIALIZED" (exactly one FileVersion, versionNumber 1,
 *                  with canonical sha256/fileSize - returned alongside),
 *                  or "INVALID" (any other, unexpected server-side state -
 *                  missing/mismatched lineage, more than one FileVersion, a
 *                  lone row whose versionNumber isn't 1, or non-canonical
 *                  integrity metadata on that lone row).
 *
 * Replaces inferring this from `GET /api/desktop/cad-documents/latest-versions`
 * (a generic "recognized latest version" lookup that cannot distinguish a
 * genuinely PENDING fresh reservation from an unknown/malformed id - see
 * `copy-design-operation-status-core.ts`'s doc comment for the full
 * rationale) for CAD Connect's RESUME decision.
 *
 * Bearer-authenticated (P4A desktop session) OR NextAuth cookie, tenant-
 * scoped, VIEWER-ok, strictly READ-ONLY (no mutation of any kind). An
 * operation id belonging to a different organization is INDISTINGUISHABLE
 * from one that does not exist at all - both are 404, never leaked.
 *
 * Status: 400 disallowed transport / malformed operationId; 401 no or
 * invalid session; 404 no such operation in the caller's organization; 200
 * with the `arch-plm.copy-design-operation-status.v1` DTO.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  try {
    assertRequestTransportAllowed(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  let actor;
  try {
    actor = await resolveApiActor(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const { operationId: rawOperationId } = await ctx.params;
  let operationId: string;
  try {
    operationId = parseOperationId(rawOperationId);
  } catch (error) {
    if (error instanceof CopyDesignOperationStatusValidationError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const { status, body } = await copyDesignOperationStatusHttpResult(actor, operationId);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
