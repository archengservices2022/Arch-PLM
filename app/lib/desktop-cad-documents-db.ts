/**
 * Arch PLM - desktop CAD-document resolve: Prisma wiring (P4B).
 *
 * Deliberately does NOT import "server-only" and takes `db` as a required
 * parameter, mirroring `desktop-auth-db.ts` / `get-latest-db.ts` - so the
 * plain Node test runner can exercise it with an in-memory fake.
 *
 * TENANT RULE: every lookup is filtered by `organizationId =
 * actor.organizationId`, taken only from the verified `Actor` the caller
 * passes in. A caller can never resolve another organization's document; a
 * cross-tenant id or number is reported as 404 (not found), never leaked.
 *
 * READ-ONLY: no `.update()` / `.create()` / `.delete()`. VIEWER-compatible -
 * this is a read and is NOT gated on write roles.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";

import {
  DESKTOP_CAD_DOC_CONTRACT,
  DesktopCadDocError,
  parseCadDocumentQuery,
  type CadDocumentQuery,
  type ResolvedCadDocumentDto,
} from "./desktop-cad-documents-core.ts";

export { DesktopCadDocError };
export type { ResolvedCadDocumentDto };

/** The slice of PrismaClient this module needs. */
export type DesktopCadDocDb = Pick<PrismaClient, "cadDocument">;

const NOT_FOUND_MESSAGE =
  "No CAD document matched that lookup in your organization.";

/**
 * Resolve a tenant document (by number or by id) to its authoritative
 * identity. Throws `DesktopCadDocError(404)` when nothing matches in the
 * actor's organization - the message never restates the lookup value.
 */
export async function resolveCadDocumentForActor(
  actor: Actor,
  query: CadDocumentQuery,
  db: DesktopCadDocDb,
): Promise<ResolvedCadDocumentDto> {
  const where =
    query.kind === "documentNumber"
      ? { organizationId: actor.organizationId, documentNumber: query.value }
      : { organizationId: actor.organizationId, id: query.value };

  const row = await db.cadDocument.findFirst({
    where,
    select: { id: true, documentNumber: true, fileName: true, documentType: true },
  });

  if (!row) {
    throw new DesktopCadDocError(404, NOT_FOUND_MESSAGE);
  }

  return {
    contract: DESKTOP_CAD_DOC_CONTRACT,
    cadDocumentId: row.id,
    documentNumber: row.documentNumber,
    fileName: row.fileName,
    cadType: String(row.documentType),
  };
}

export interface DesktopCadDocHttpResult {
  status: number;
  body: unknown;
}

/**
 * Map an authenticated (or unauthenticated) resolve request to an HTTP
 * status + JSON body. Kept out of the route handler so it is unit-testable
 * without a running server.
 *
 * 401 no actor; 400 malformed query; 404 no match in the tenant; 200 with
 * the ResolvedCadDocumentDto otherwise.
 */
export async function desktopResolveHttpResult(
  actor: Actor | null,
  params: URLSearchParams,
  db: DesktopCadDocDb,
): Promise<DesktopCadDocHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required." } };
  }

  try {
    const query = parseCadDocumentQuery(params);
    const dto = await resolveCadDocumentForActor(actor, query, db);
    return { status: 200, body: dto };
  } catch (error) {
    if (error instanceof DesktopCadDocError) {
      return { status: error.status, body: { error: error.publicMessage } };
    }
    throw error;
  }
}
