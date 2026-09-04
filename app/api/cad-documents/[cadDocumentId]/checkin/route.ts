import { Readable } from "node:stream";

import { getActor } from "@/app/lib/authz";
import { checkInHttpResult } from "@/app/lib/checkin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cad-documents/:cadDocumentId/checkin
 *
 * Check in the actor's active checkout of a CAD document, uploading the
 * edited binary as the next immutable FileVersion and removing the
 * checkout. The file is sent as the RAW request body (not multipart) with
 * an optional `X-Original-Filename` header, exactly like
 * `POST .../file-versions`. The body is streamed straight into storage: it
 * is never buffered whole, and the configured maximum size is enforced
 * while reading (Content-Length is not trusted). SHA-256, byte size,
 * storageKey, organizationId and createdById are all computed server-side.
 *
 * Only the actor who holds the checkout may check in, and only against the
 * exact FileVersion the checkout was taken against - see
 * `app/lib/checkin-db.ts` for the full concurrency/stale-base design. A
 * failed check-in (any reason) never touches the active checkout or creates
 * a FileVersion.
 *
 * Status codes: 401 unauthenticated, 403 role cannot check in (VIEWER),
 * 404 cross-tenant/nonexistent document, 409 not checked out / checked out
 * by another actor / stale base / lost a concurrent check-in race,
 * 413 upload too large, 400 empty upload, 201 created.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ cadDocumentId: string }> },
): Promise<Response> {
  const actor = await getActor();
  const { cadDocumentId } = await ctx.params;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return Response.json(
      { error: "Send the file as the raw request body, not multipart/form-data" },
      { status: 415 },
    );
  }

  const originalFileName = request.headers.get("x-original-filename");
  const source = request.body
    ? Readable.fromWeb(
        request.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      )
    : null;

  const { status, body } = await checkInHttpResult(
    actor,
    cadDocumentId,
    source,
    originalFileName,
  );

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
