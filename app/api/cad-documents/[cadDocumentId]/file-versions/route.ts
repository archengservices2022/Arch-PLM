import { Readable } from "node:stream";

import { getActor, assertCanMutate } from "@/app/lib/authz";
import {
  ActiveCheckoutBlocksUploadError,
  CadDocumentNotFoundError,
  ReservedCopyDesignTargetError,
  UploadConcurrencyConflictError,
  storeCadFileVersion,
} from "@/app/lib/storage";
import { EmptyUploadError, UploadTooLargeError } from "@/app/lib/storage-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cad-documents/:cadDocumentId/file-versions
 *
 * Upload a binary and create the next immutable FileVersion for the CAD
 * document. The file is sent as the RAW request body (not multipart) with an
 * optional `X-Original-Filename` header. The body is streamed straight into
 * storage: it is never buffered whole, and the configured maximum size is
 * enforced while reading (Content-Length is not trusted).
 *
 * SHA-256, byte size, storageKey, organizationId and createdById are all
 * computed server-side. Never creates or mutates an ItemRevision.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  if (!actor) {
    return jsonError(401, "Authentication required");
  }
  try {
    assertCanMutate(actor);
  } catch {
    return jsonError(403, "You do not have permission to upload files");
  }

  const { cadDocumentId } = await ctx.params;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return jsonError(
      415,
      "Send the file as the raw request body, not multipart/form-data",
    );
  }

  if (!request.body) {
    return jsonError(400, "Empty upload");
  }

  const originalFileName = request.headers.get("x-original-filename");
  const source = Readable.fromWeb(
    request.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );

  try {
    const result = await storeCadFileVersion(
      actor,
      cadDocumentId,
      source,
      originalFileName,
    );

    return Response.json(
      {
        fileVersionId: result.fileVersionId,
        versionNumber: result.versionNumber,
        checksum: result.checksum,
        fileSize: result.fileSize,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CadDocumentNotFoundError) {
      return jsonError(404, error.message);
    }
    if (error instanceof ActiveCheckoutBlocksUploadError) {
      return jsonError(409, error.message);
    }
    if (error instanceof ReservedCopyDesignTargetError) {
      return jsonError(409, error.message);
    }
    if (error instanceof UploadConcurrencyConflictError) {
      return jsonError(409, error.message);
    }
    if (error instanceof UploadTooLargeError) {
      return jsonError(413, "File exceeds the maximum upload size");
    }
    if (error instanceof EmptyUploadError) {
      return jsonError(400, "Empty upload");
    }
    throw error;
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
