/**
 * Arch PLM - desktop authoritative-drawing-association lookup: Prisma wiring
 * (P6D Drawing Association Authority).
 *
 * Deliberately does NOT import "server-only" and takes `db` as a required
 * parameter, mirroring `desktop-latest-versions-db.ts` / `get-latest-db.ts` -
 * so the plain Node test runner can exercise it with an in-memory fake.
 *
 * TENANT RULE: EVERY database read is filtered by
 * `organizationId = actor.organizationId`, taken only from the verified
 * `Actor` the caller passes in. A cross-tenant `cadDocumentId` can never
 * match and is reported as `recognized: false`, byte-for-byte identical to
 * an unknown id - no cross-tenant existence or association data is leaked.
 *
 * DIRECTION: `CadDependency.dependencyType = "DRAWING_REFERENCE"` means the
 * `parentDocument` is the drawing and the `childDocument` is the model (see
 * prisma/schema.prisma's own enum comment). This module queries by
 * `childDocumentId = <requested model id>` and returns the matching
 * `parentDocument`s - it never reverses this direction and never widens the
 * query to any other `dependencyType`.
 *
 * READ-ONLY: only `.findMany()`. No `.create()` / `.update()` / `.delete()`,
 * no storage access. VIEWER-compatible.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";

import {
  DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT,
  DesktopDrawingAssociationError,
  parseDrawingAssociationModelIds,
  type AssociatedDrawingDto,
  type DrawingAssociationResultDto,
  type DrawingAssociationsResponseDto,
} from "./desktop-drawing-associations-core.ts";

export { DesktopDrawingAssociationError };
export type { DrawingAssociationsResponseDto };

/** The slice of PrismaClient this module needs. */
export type DesktopDrawingAssociationDb = Pick<PrismaClient, "cadDocument" | "cadDependency" | "fileVersion">;

/**
 * For each EXACT `cadDocumentId` in `requestedIds`, resolve whether it is a
 * `CadDocument` in the actor's organization and, if so, EVERY drawing an
 * authoritative `DRAWING_REFERENCE` row associates with it. Returns the
 * response DTO, `results[]` in request order.
 */
export async function drawingAssociationsForActor(
  actor: Actor,
  requestedIds: readonly string[],
  db: DesktopDrawingAssociationDb,
): Promise<DrawingAssociationsResponseDto> {
  // 1. Which requested ids are CadDocuments in THIS tenant.
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

  // 2. Every authoritative DRAWING_REFERENCE edge whose MODEL (child) is one
  //    of the recognized requested ids - drawing (parent) identity + type
  //    only, in ONE tenant-scoped query.
  const edges =
    recognizedDocIds.size === 0
      ? []
      : await db.cadDependency.findMany({
          where: {
            organizationId: actor.organizationId,
            dependencyType: "DRAWING_REFERENCE",
            childDocumentId: { in: [...recognizedDocIds] },
          },
          select: {
            childDocumentId: true,
            parentDocument: {
              select: { id: true, documentNumber: true, fileName: true, documentType: true },
            },
          },
        });

  // 3. The authoritative latest FileVersion per drawing (parent) found above -
  //    same "greatest versionNumber wins" rule as Get Latest / latest-versions.
  const drawingIds = new Set(edges.map((e) => e.parentDocument.id));
  const latestFileVersionByDrawing = new Map<string, string>();
  if (drawingIds.size > 0) {
    const rows = await db.fileVersion.findMany({
      where: {
        organizationId: actor.organizationId,
        cadDocumentId: { in: [...drawingIds] },
      },
      orderBy: [{ cadDocumentId: "asc" }, { versionNumber: "desc" }],
      distinct: ["cadDocumentId"],
      select: { cadDocumentId: true, id: true },
    });
    for (const row of rows) {
      latestFileVersionByDrawing.set(row.cadDocumentId, row.id);
    }
  }

  // 4. Group drawings by the model (child) id they were found for.
  const drawingsByModel = new Map<string, AssociatedDrawingDto[]>();
  for (const edge of edges) {
    const list = drawingsByModel.get(edge.childDocumentId) ?? [];
    list.push({
      cadDocumentId: edge.parentDocument.id,
      documentNumber: edge.parentDocument.documentNumber,
      fileName: edge.parentDocument.fileName,
      cadType: String(edge.parentDocument.documentType),
      currentFileVersionId: latestFileVersionByDrawing.get(edge.parentDocument.id) ?? null,
    });
    drawingsByModel.set(edge.childDocumentId, list);
  }

  const results: DrawingAssociationResultDto[] = requestedIds.map((cadDocumentId) => {
    if (!recognizedDocIds.has(cadDocumentId)) {
      return { cadDocumentId, recognized: false };
    }
    // Deterministic order: by the drawing's own cadDocumentId.
    const drawings = (drawingsByModel.get(cadDocumentId) ?? [])
      .slice()
      .sort((a, b) => a.cadDocumentId.localeCompare(b.cadDocumentId));
    return { cadDocumentId, recognized: true, drawings };
  });

  return { contract: DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT, results };
}

export interface DesktopDrawingAssociationHttpResult {
  status: number;
  body: unknown;
}

/**
 * Map an authenticated (or unauthenticated) drawing-associations request to
 * an HTTP status + JSON body. Kept out of the route handler so it is
 * unit-testable without a running server.
 *
 * 401 no actor; 400 malformed / unbounded query; 200 with the contract DTO
 * otherwise (per-id `recognized` true/false, `recognized: true` carrying a
 * possibly-empty `drawings` array).
 */
export async function desktopDrawingAssociationsHttpResult(
  actor: Actor | null,
  params: URLSearchParams,
  db: DesktopDrawingAssociationDb,
): Promise<DesktopDrawingAssociationHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required." } };
  }

  try {
    const ids = parseDrawingAssociationModelIds(params);
    const dto = await drawingAssociationsForActor(actor, ids, db);
    return { status: 200, body: dto };
  } catch (error) {
    if (error instanceof DesktopDrawingAssociationError) {
      return { status: error.status, body: { error: error.publicMessage } };
    }
    throw error;
  }
}
