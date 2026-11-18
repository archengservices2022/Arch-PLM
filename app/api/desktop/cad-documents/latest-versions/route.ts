import type { Actor } from "@/app/lib/authz";
import { DesktopAuthError, resolveDesktopApiActor } from "@/app/lib/api-actor";
import { assertRequestTransportAllowed } from "@/app/lib/desktop-auth-core";
import { desktopLatestVersionsHttpResult } from "@/app/lib/desktop-latest-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/desktop/cad-documents/latest-versions
 *       ?cadDocumentId=<id>&cadDocumentId=<id>...
 *
 * The Arch CAD Connect P5B-B client's authoritative version check: for a batch
 * of EXACT stable `cadDocumentId`s it already holds (from its verified
 * workspace manifest), report - within the authenticated actor's organization
 * ONLY - whether each id is recognised and, if so, its authoritative latest
 * `FileVersion` id + number + that FileVersion's canonical immutable integrity
 * metadata (`checksum`: 64-char lowercase-hex SHA-256; `fileSize`: non-negative
 * safe-integer byte count; from the selected DB row only), so the client can
 * cryptographically verify a local binary is exactly that version. A recognised
 * latest `FileVersion` whose stored integrity metadata is missing, non-canonical,
 * or out of safe range fails closed to `recognized: false` (P5C-B).
 *
 * Bearer-authenticated (P4A desktop session), tenant-scoped, VIEWER-ok,
 * strictly READ-ONLY (no mutation, no checkout, no FileVersion creation, no
 * storage access). A cross-tenant / unknown id is `recognized: false` - never
 * leaked. Requires the desktop transport policy (HTTPS unless loopback).
 *
 * Status: 400 disallowed transport / malformed / unbounded query, 401 no or
 * invalid session, 200 with the `arch-plm.desktop-latest-versions.v1` DTO.
 */
export async function GET(request: Request): Promise<Response> {
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
    actor = await resolveDesktopApiActor(request);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      return Response.json({ error: error.publicMessage }, { status: error.status });
    }
    throw error;
  }

  const params = new URL(request.url).searchParams;
  const { status, body } = await desktopLatestVersionsHttpResult(actor, params);

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
