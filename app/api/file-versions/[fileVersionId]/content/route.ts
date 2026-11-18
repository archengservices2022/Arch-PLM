import { Readable } from "node:stream";

import { DesktopAuthError, resolveApiActor } from "@/app/lib/api-actor";
import {
  FileVersionNotFoundError,
  StoredFileCorruptError,
  StoredFileMissingError,
  StoredFileUnverifiedError,
  readCadFileVersionForActor,
} from "@/app/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/file-versions/:fileVersionId/content
 *
 * Stream the exact bytes of one FileVersion to the authenticated actor. The
 * lookup is tenant-scoped (organizationId = actor.organizationId), so a caller
 * can never download another organization's version. The stored object is
 * streamed through SHA-256 and checked against the recorded checksum before
 * any bytes are served (a corrupt object -> 500, never served; WP-2A: a
 * version with NO recorded checksum -> 422, never served unverified); the
 * file is never loaded into memory whole.
 *
 * AUTH (P4B): accepts EITHER the browser NextAuth cookie (unchanged) OR a
 * P4A desktop bearer token; a bearer request must also satisfy the transport
 * policy. Tenant + role are re-derived server-side; reads are
 * VIEWER-compatible.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ fileVersionId: string }> },
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
  if (!actor) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { fileVersionId } = await ctx.params;

  try {
    const file = await readCadFileVersionForActor(actor, fileVersionId);

    // Pipe the provider's read stream straight to the response. A filesystem
    // path is never exposed to the client.
    const body = Readable.toWeb(
      file.stream,
    ) as unknown as ReadableStream<Uint8Array>;

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.fileSize),
        "Content-Disposition": contentDisposition(file.originalFileName),
        "X-Content-SHA256": file.checksum,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (
      error instanceof FileVersionNotFoundError ||
      error instanceof StoredFileMissingError
    ) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof StoredFileCorruptError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (error instanceof StoredFileUnverifiedError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

/** A header-safe Content-Disposition: an ASCII fallback plus RFC 5987 UTF-8. */
function contentDisposition(name: string): string {
  const asciiFallback =
    name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download.bin";
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
