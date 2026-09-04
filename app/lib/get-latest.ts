import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { getStorageProvider } from "@/app/lib/storage";
import type { StorageProvider } from "@/app/lib/storage-core";
import {
  buildGetLatestDeps as buildGetLatestDepsWith,
  getLatestManifestForActor as getLatestManifestForActorWith,
  getLatestManifestHttpResult as getLatestManifestHttpResultWith,
  CadGraphTooLargeError,
  RootCadDocumentNotFoundError,
  type GetLatestDb,
  type GetLatestHttpResult,
  type GetLatestManifest,
} from "@/app/lib/get-latest-db";

/**
 * Server-only entry point for the PDM "Get Latest" manifest.
 *
 * This is a thin shim: all traversal/manifest logic lives in the pure
 * `get-latest-core.ts`, and all Prisma-shaped query logic + tenant scoping
 * lives in the plain (non-`server-only`) `get-latest-db.ts`, which is what the
 * focused tests exercise directly with an in-memory fake database and a fake
 * actor. This module only supplies the real `prisma` client and storage
 * provider as defaults and re-asserts the server-only boundary.
 */

export { CadGraphTooLargeError, RootCadDocumentNotFoundError };
export type { GetLatestManifest, GetLatestHttpResult, GetLatestDb };

export function buildGetLatestDeps(
  organizationId: string,
  db: GetLatestDb = prisma,
  provider: StorageProvider = getStorageProvider(),
) {
  return buildGetLatestDepsWith(organizationId, db, provider);
}

export async function getLatestManifestForActor(
  actor: Actor,
  rootCadDocumentId: string,
  db: GetLatestDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<GetLatestManifest> {
  return getLatestManifestForActorWith(actor, rootCadDocumentId, db, provider);
}

export async function getLatestManifestHttpResult(
  actor: Actor | null,
  rootCadDocumentId: string,
  db: GetLatestDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<GetLatestHttpResult> {
  return getLatestManifestHttpResultWith(
    actor,
    rootCadDocumentId,
    db,
    provider,
  );
}
