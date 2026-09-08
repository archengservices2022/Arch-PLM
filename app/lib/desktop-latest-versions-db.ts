/**
 * Arch PLM - desktop authoritative-latest-version lookup: Prisma wiring
 * (P5B-B server companion).
 *
 * Deliberately does NOT import "server-only" and takes `db` as a required
 * parameter, mirroring `desktop-cad-documents-db.ts` / `desktop-auth-db.ts` /
 * `get-latest-db.ts` - so the plain Node test runner can exercise it with an
 * in-memory fake.
 *
 * TENANT RULE: EVERY database read is filtered by
 * `organizationId = actor.organizationId`, taken only from the verified
 * `Actor` the caller passes in. A cross-tenant `cadDocumentId` can never match
 * and is reported as `recognized: false`, byte-for-byte identical to an
 * unknown id - no cross-tenant existence or FileVersion metadata is leaked.
 *
 * READ-ONLY: only `.findMany()`. No `.create()` / `.update()` / `.delete()`,
 * no storage access, no checkout/check-in. VIEWER-compatible.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";

import {
  buildLatestVersionResults,
  DESKTOP_LATEST_VERSIONS_CONTRACT,
  DesktopLatestVersionError,
  parseLatestVersionIds,
  type AuthoritativeLatest,
  type LatestVersionsResponseDto,
} from "./desktop-latest-versions-core.ts";

export { DesktopLatestVersionError };
export type { LatestVersionsResponseDto };

/** The slice of PrismaClient this module needs. */
export type DesktopLatestVersionDb = Pick<PrismaClient, "cadDocument" | "fileVersion">;

/**
 * For each EXACT `cadDocumentId` in `requestedIds`, resolve whether it is a
 * `CadDocument` in the actor's organization and, if so, its authoritative
 * latest `FileVersion` (greatest `versionNumber`). Returns the response DTO,
 * `results[]` in request order.
 */
export async function latestVersionsForActor(
  actor: Actor,
  requestedIds: readonly string[],
  db: DesktopLatestVersionDb,
): Promise<LatestVersionsResponseDto> {
  // 1. Which requested ids are CadDocuments in THIS tenant. The composite
  //    `@@unique([organizationId, id])` makes this the tenant boundary - a
  //    foreign-org document's id never matches `organizationId`.
  const docs =
    requestedIds.length === 0
      ? []
      : await db.cadDocument.findMany({
          where: {
            organizationId: actor.organizationId,
            id: { in: [...requestedIds] },
          },
          select: { id: true },
        });
  const recognizedDocIds = new Set(docs.map((d) => d.id));

  // 2. The authoritative latest FileVersion per recognised document, in ONE
  //    tenant-scoped query: order by (cadDocumentId, versionNumber desc) and
  //    keep the first row per cadDocumentId.
  const latestByDoc = new Map<string, AuthoritativeLatest>();
  if (recognizedDocIds.size > 0) {
    const rows = await db.fileVersion.findMany({
      where: {
        organizationId: actor.organizationId,
        cadDocumentId: { in: [...recognizedDocIds] },
      },
      orderBy: [{ cadDocumentId: "asc" }, { versionNumber: "desc" }],
      distinct: ["cadDocumentId"],
      select: { cadDocumentId: true, id: true, versionNumber: true },
    });
    for (const row of rows) {
      latestByDoc.set(row.cadDocumentId, {
        latestFileVersionId: row.id,
        latestVersionNumber: row.versionNumber,
      });
    }
  }

  return {
    contract: DESKTOP_LATEST_VERSIONS_CONTRACT,
    results: buildLatestVersionResults(requestedIds, recognizedDocIds, latestByDoc),
  };
}

export interface DesktopLatestVersionHttpResult {
  status: number;
  body: unknown;
}

/**
 * Map an authenticated (or unauthenticated) latest-versions request to an
 * HTTP status + JSON body. Kept out of the route handler so it is
 * unit-testable without a running server.
 *
 * 401 no actor; 400 malformed / unbounded query; 200 with the contract DTO
 * otherwise (per-id `recognized` true/false).
 */
export async function desktopLatestVersionsHttpResult(
  actor: Actor | null,
  params: URLSearchParams,
  db: DesktopLatestVersionDb,
): Promise<DesktopLatestVersionHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required." } };
  }

  try {
    const ids = parseLatestVersionIds(params);
    const dto = await latestVersionsForActor(actor, ids, db);
    return { status: 200, body: dto };
  } catch (error) {
    if (error instanceof DesktopLatestVersionError) {
      return { status: error.status, body: { error: error.publicMessage } };
    }
    throw error;
  }
}
