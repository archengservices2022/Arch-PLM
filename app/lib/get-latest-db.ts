/**
 * Arch PDM - "Get Latest" manifest: Prisma-shaped wiring.
 *
 * This module binds the pure core (`app/lib/get-latest-core.ts`) to a
 * Prisma-like database handle and a StorageProvider. Unlike `app/lib/get-latest.ts`
 * it does NOT import "server-only" and takes `db` / `provider` as required
 * parameters (no singleton defaults, no side-effecting imports) - only `Actor`
 * and `PrismaClient` are imported, and only as types (erased at compile time).
 * Its runtime imports of sibling modules use explicit relative `.ts` paths (not
 * the `@/` alias, which only Next's bundler understands) so this file can be
 * loaded directly by the plain Node test runner - not just bundled by Next.
 * The route / server surface is `app/lib/get-latest.ts`, a thin
 * `server-only`-guarded shim that supplies the real `prisma` client and
 * storage provider as defaults.
 *
 * EVERY query below is filtered by `organizationId = actor.organizationId`.
 * The organization comes only from the verified `Actor` the caller passes in -
 * never from a route param, header or body - so a caller can never traverse
 * into or resolve another tenant's documents, versions or binaries.
 *
 * This never reads or writes ItemRevision / lifecycle state.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { assertSafeRelativeKey, type StorageProvider } from "./storage-core.ts";
import {
  buildGetLatestManifest,
  CadGraphTooLargeError,
  RootCadDocumentNotFoundError,
  type GetLatestDeps,
  type GetLatestManifest,
} from "./get-latest-core.ts";

export { CadGraphTooLargeError, RootCadDocumentNotFoundError };
export type { GetLatestManifest };

/** The slice of PrismaClient this module needs. Narrowed so tests can inject a
 *  lightweight in-memory fake with the same shape. */
export type GetLatestDb = Pick<
  PrismaClient,
  "cadDocument" | "cadDependency" | "fileVersion"
>;

const MAX_VERSIONS_SCANNED = 500;

export function buildGetLatestDeps(
  organizationId: string,
  db: GetLatestDb,
  provider: StorageProvider,
): GetLatestDeps {
  return {
    maxVersionsScanned: MAX_VERSIONS_SCANNED,

    async loadDocuments(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db.cadDocument.findMany({
        where: { organizationId, id: { in: ids } },
        select: {
          id: true,
          documentNumber: true,
          fileName: true,
          documentType: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        documentNumber: row.documentNumber,
        fileName: row.fileName,
        cadType: String(row.documentType),
      }));
    },

    async loadChildEdges(parentDocumentIds) {
      if (parentDocumentIds.length === 0) {
        return [];
      }
      const rows = await db.cadDependency.findMany({
        where: {
          organizationId,
          parentDocumentId: { in: parentDocumentIds },
        },
        select: {
          parentDocumentId: true,
          childDocumentId: true,
          dependencyType: true,
        },
      });
      return rows.map((row) => ({
        parentDocumentId: row.parentDocumentId,
        childDocumentId: row.childDocumentId,
        dependencyType: String(row.dependencyType),
      }));
    },

    async loadVersionsNewestFirst(cadDocumentId) {
      const rows = await db.fileVersion.findMany({
        where: { organizationId, cadDocumentId },
        orderBy: { versionNumber: "desc" },
        take: MAX_VERSIONS_SCANNED,
        select: {
          id: true,
          versionNumber: true,
          checksum: true,
          fileSize: true,
          originalFileName: true,
          storageKey: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        versionNumber: row.versionNumber,
        checksum: row.checksum,
        fileSize: row.fileSize == null ? null : Number(row.fileSize),
        originalFileName: row.originalFileName,
        storageKey: row.storageKey,
      }));
    },

    async objectExists(storageKey) {
      // Keys are server-generated, but validate before touching storage anyway.
      try {
        assertSafeRelativeKey(storageKey);
      } catch {
        return false;
      }
      return provider.exists(storageKey);
    },
  };
}

/**
 * Build the Get Latest manifest for a root CAD document, scoped to the actor's
 * organization.
 *
 * @throws RootCadDocumentNotFoundError when the root does not exist in the
 *   actor's organization (this is also how cross-tenant access surfaces).
 * @throws CadGraphTooLargeError when the dependency graph exceeds the node cap.
 */
export async function getLatestManifestForActor(
  actor: Actor,
  rootCadDocumentId: string,
  db: GetLatestDb,
  provider: StorageProvider,
): Promise<GetLatestManifest> {
  const deps = buildGetLatestDeps(actor.organizationId, db, provider);
  return buildGetLatestManifest(rootCadDocumentId, deps);
}

export interface GetLatestHttpResult {
  status: number;
  body: unknown;
}

/**
 * Map an authenticated (or unauthenticated) Get Latest request to an HTTP
 * status + JSON body. Kept out of the route handler so it is unit-testable
 * without a running server.
 *
 * An incomplete package (missing binaries, path collisions, dangling edges) is
 * still returned as 200 with `complete: false` and a populated `problems`
 * array - the manifest reports the problem, it never silently omits a document.
 */
export async function getLatestManifestHttpResult(
  actor: Actor | null,
  rootCadDocumentId: string,
  db: GetLatestDb,
  provider: StorageProvider,
): Promise<GetLatestHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (
    typeof rootCadDocumentId !== "string" ||
    rootCadDocumentId.length === 0 ||
    rootCadDocumentId.length > 200
  ) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }

  try {
    const manifest = await getLatestManifestForActor(
      actor,
      rootCadDocumentId,
      db,
      provider,
    );
    return { status: 200, body: manifest };
  } catch (error) {
    if (error instanceof RootCadDocumentNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    if (error instanceof CadGraphTooLargeError) {
      return { status: 422, body: { error: error.message } };
    }
    throw error;
  }
}
