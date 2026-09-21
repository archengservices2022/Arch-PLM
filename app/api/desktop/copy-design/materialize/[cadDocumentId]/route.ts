import { Readable } from "node:stream";

import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import { CopyDesignMaterializeValidationError, parseMaterializeRequestHeaders } from "@/app/lib/copy-design-materialize-core";
import { copyDesignMaterializeHttpResult } from "@/app/lib/copy-design-materialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/desktop/copy-design/materialize/:cadDocumentId
 *
 * P6C server bridge: attach FileVersion 1 to a CadDocument the EXISTING P6B
 * contract (`POST /api/desktop/copy-design/apply`) already reserved - a
 * CadCopyLineage row names it as the NEW document and it currently has zero
 * FileVersion rows. CAD Connect calls this ONLY after it has physically
 * created, rewired, and locally verified the resulting Inventor IAM/IPT
 * binary - never before.
 *
 * The file is sent as the RAW request body (not multipart), exactly like
 * `POST /api/cad-documents/:id/checkin`. The remaining metadata this
 * endpoint needs beyond `:cadDocumentId` travels as headers, mirroring the
 * existing `X-Original-Filename` convention:
 *
 *   X-Copy-Design-Operation-Id   (required)
 *   X-Source-Cad-Document-Id     (required - the exact source lineage proof)
 *   X-Document-Type              (required - IPT/IAM/IDW/DWG/PDF/OTHER)
 *   X-Expected-Sha256            (required - 64 lowercase hex chars)
 *   X-Expected-File-Size         (required - positive integer, bytes)
 *   X-Original-Filename          (optional)
 *
 * The body is streamed straight into storage: never buffered whole, and the
 * configured maximum size is enforced while reading (Content-Length is not
 * trusted). SHA-256 and byte size are computed server-side and must match
 * the declared `X-Expected-*` headers exactly, or the request is rejected
 * BEFORE anything is persisted - the declared headers are a claim to be
 * verified, never trusted metadata.
 *
 * Never accesses PostgreSQL directly from CAD Connect - this endpoint is the
 * sole seam. organizationId / userId / createdById are always server-derived
 * from the authenticated actor, never the request.
 *
 * AUTH: bearer (P4A desktop session) OR NextAuth cookie, subject to the same
 * desktop transport policy as every other desktop route (`resolveApiActor`).
 * Requires the same mutation floor as check-in/checkout (VIEWER is 403).
 *
 * Status codes: 400 disallowed transport / malformed headers / empty upload /
 * uploaded-bytes-vs-declared mismatch; 401 no/invalid session; 403 role
 * cannot mutate; 404 not an eligible reserved Copy Design target in the
 * actor's organization (also how cross-tenant access, a non-copy document, a
 * wrong operation id, or a wrong source id all surface - never
 * distinguished); 409 FileVersion 1 already exists with different content, or
 * a concurrency conflict; 413 too large; 200 idempotent replay (identical
 * retry); 201 created.
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

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return Response.json(
      { error: "Send the file as the raw request body, not multipart/form-data" },
      { status: 415 },
    );
  }

  let meta;
  try {
    meta = parseMaterializeRequestHeaders(
      {
        copyDesignOperationId: request.headers.get("x-copy-design-operation-id"),
        sourceCadDocumentId: request.headers.get("x-source-cad-document-id"),
        documentType: request.headers.get("x-document-type"),
        originalFileName: request.headers.get("x-original-filename"),
        expectedSha256: request.headers.get("x-expected-sha256"),
        expectedFileSize: request.headers.get("x-expected-file-size"),
      },
      cadDocumentId.trim(),
    );
  } catch (error) {
    if (error instanceof CopyDesignMaterializeValidationError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const source = request.body
    ? Readable.fromWeb(request.body as unknown as Parameters<typeof Readable.fromWeb>[0])
    : null;

  const { status, body } = await copyDesignMaterializeHttpResult(actor, meta, source);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
