import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { getStorageProvider } from "@/app/lib/storage";
import type { StorageProvider } from "@/app/lib/storage-core";
import {
  getReleasedWorkspacePlanForActor as getReleasedWorkspacePlanForActorWith,
  getReleasedWorkspaceHttpResult as getReleasedWorkspaceHttpResultWith,
  ItemRevisionNotFoundError,
  ReleaseBaselineMissingError,
  ReleasedBinaryIntegrityError,
  RevisionNotReleasedError,
  type ReleasedWorkspaceDb,
  type ReleasedWorkspaceHttpResult,
  type ReleasedWorkspacePlan,
} from "@/app/lib/released-workspace-db";

/**
 * Server-only entry point for Released Revision retrieval (P3D-2).
 *
 * Thin shim: all domain logic lives in the pure `released-workspace-core.ts`,
 * and all Prisma-shaped query logic lives in the plain (non-`server-only`)
 * `released-workspace-db.ts`, which is what the focused tests exercise
 * directly with an in-memory fake database. This module only supplies the
 * real `prisma` client and storage provider as defaults.
 */

export {
  ItemRevisionNotFoundError,
  ReleaseBaselineMissingError,
  ReleasedBinaryIntegrityError,
  RevisionNotReleasedError,
};
export type { ReleasedWorkspaceDb, ReleasedWorkspaceHttpResult, ReleasedWorkspacePlan };

export async function getReleasedWorkspacePlanForActor(
  actor: Actor,
  itemRevisionId: string,
  db: ReleasedWorkspaceDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<ReleasedWorkspacePlan> {
  return getReleasedWorkspacePlanForActorWith(actor, itemRevisionId, db, provider);
}

export async function getReleasedWorkspaceHttpResult(
  actor: Actor | null,
  itemRevisionId: string,
  db: ReleasedWorkspaceDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<ReleasedWorkspaceHttpResult> {
  return getReleasedWorkspaceHttpResultWith(actor, itemRevisionId, db, provider);
}
