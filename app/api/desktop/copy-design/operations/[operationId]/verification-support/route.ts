import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import { assertRequestTransportAllowed } from "@/app/lib/desktop-auth-core";
import { CopyDesignOperationStatusValidationError, parseOperationId } from "@/app/lib/copy-design-operation-status-core";
import { copyDesignVerificationSupportHttpResult } from "@/app/lib/copy-design-verification-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desktop/copy-design/operations/:operationId/verification-support
 *
 * P6E-A: a SEPARATE, additive, READ-ONLY endpoint carrying exactly the
 * durable facts an independent, later, read-only re-verification of ONE
 * completed (or partially completed) Copy Design operation needs, beyond
 * what `GET .../status` (P6D, unmodified by this endpoint) already reports:
 *
 *   - the operation's own status.v1 payload, embedded verbatim
 *     (`operationStatus`) - reused, never re-derived;
 *   - the authoritative SHA-256/fileSize of every COPY entry's SOURCE
 *     FileVersion (`sourceFileVersionIntegrity`) - metadata only, no binary
 *     content is ever streamed by this endpoint;
 *   - the operation's own COMPONENT `CadDependency` topology
 *     (`componentEdges`), scoped strictly to this operation's own document
 *     identities.
 *
 * This endpoint makes NO verification decision (VERIFIED/FAILED/INCOMPLETE)
 * itself - it only surfaces facts. It never creates, updates, or deletes
 * anything.
 *
 * Bearer-authenticated (P4A desktop session) OR NextAuth cookie, tenant-
 * scoped, VIEWER-ok, strictly READ-ONLY. An operation id belonging to a
 * different organization is INDISTINGUISHABLE from one that does not exist
 * at all - both are 404, never leaked (identical to `.../status`).
 *
 * Status: 400 disallowed transport / malformed operationId; 401 no or
 * invalid session; 404 no such operation in the caller's organization; 200
 * with the `arch-plm.copy-design-verification-support.v1` DTO.
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

  const { status, body } = await copyDesignVerificationSupportHttpResult(actor, operationId);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
