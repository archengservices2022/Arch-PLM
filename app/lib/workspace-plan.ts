import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { getStorageProvider } from "@/app/lib/storage";
import type { StorageProvider } from "@/app/lib/storage-core";
import {
  getWorkspacePlanForActor as getWorkspacePlanForActorWith,
  getWorkspacePlanHttpResult as getWorkspacePlanHttpResultWith,
  CadGraphTooLargeError,
  RootCadDocumentNotFoundError,
  type GetLatestDb,
  type WorkspacePlan,
  type WorkspacePlanHttpResult,
} from "@/app/lib/workspace-plan-db";

/**
 * Server-only entry point for the PDM Managed Workspace Plan (P3B-2A).
 *
 * This is a thin shim: all contract-shaping logic lives in the pure
 * `workspace-plan-core.ts`, and all Prisma-shaped composition (of the
 * existing Get Latest pipeline) lives in the plain (non-`server-only`)
 * `workspace-plan-db.ts`, which is what the focused tests exercise directly
 * with an in-memory fake database and a fake actor. This module only
 * supplies the real `prisma` client and storage provider as defaults and
 * re-asserts the server-only boundary.
 */

export { CadGraphTooLargeError, RootCadDocumentNotFoundError };
export type { WorkspacePlan, WorkspacePlanHttpResult, GetLatestDb };

export async function getWorkspacePlanForActor(
  actor: Actor,
  rootCadDocumentId: string,
  db: GetLatestDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<WorkspacePlan> {
  return getWorkspacePlanForActorWith(actor, rootCadDocumentId, db, provider);
}

export async function getWorkspacePlanHttpResult(
  actor: Actor | null,
  rootCadDocumentId: string,
  db: GetLatestDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<WorkspacePlanHttpResult> {
  return getWorkspacePlanHttpResultWith(
    actor,
    rootCadDocumentId,
    db,
    provider,
  );
}
