/**
 * Arch PDM - Managed Workspace Plan: Prisma-shaped wiring (P3B-2A).
 *
 * Composes the existing, already-tested Get Latest pipeline
 * (`app/lib/get-latest-db.ts`) with the pure workspace-plan transform
 * (`app/lib/workspace-plan-core.ts`). This module runs NO independent
 * database queries of its own beyond what Get Latest already does - the
 * workspace plan is built strictly FROM an authenticated, tenant-safe Get
 * Latest result, never from a client-supplied organization id, storage key
 * or path.
 *
 * Like `get-latest-db.ts`, this module deliberately does NOT import
 * "server-only" and takes `db` / `provider` as required parameters (no
 * singleton defaults). Its runtime imports of sibling modules use explicit
 * relative `.ts` paths so it stays loadable by the plain Node test runner.
 * The route / server surface is `app/lib/workspace-plan.ts`, a thin
 * `server-only`-guarded shim that supplies the real `prisma` client and
 * storage provider as defaults.
 */
import type { Actor } from "@/app/lib/authz";
import type { StorageProvider } from "./storage-core.ts";
import {
  getLatestManifestForActor,
  CadGraphTooLargeError,
  RootCadDocumentNotFoundError,
  type GetLatestDb,
} from "./get-latest-db.ts";
import {
  buildWorkspacePlanFromManifest,
  type WorkspacePlan,
} from "./workspace-plan-core.ts";

export { CadGraphTooLargeError, RootCadDocumentNotFoundError };
export type { WorkspacePlan };
export type { GetLatestDb } from "./get-latest-db.ts";

/**
 * Build the workspace plan for a root CAD document, scoped to the actor's
 * organization. Reuses the exact same tenant-scoped lookups, traversal,
 * version resolution and path-collision detection as Get Latest - this
 * function issues no new queries of its own.
 *
 * @throws RootCadDocumentNotFoundError when the root does not exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws CadGraphTooLargeError when the dependency graph exceeds the node cap.
 */
export async function getWorkspacePlanForActor(
  actor: Actor,
  rootCadDocumentId: string,
  db: GetLatestDb,
  provider: StorageProvider,
): Promise<WorkspacePlan> {
  const manifest = await getLatestManifestForActor(
    actor,
    rootCadDocumentId,
    db,
    provider,
  );
  return buildWorkspacePlanFromManifest(manifest);
}

export interface WorkspacePlanHttpResult {
  status: number;
  body: unknown;
}

/**
 * Map an authenticated (or unauthenticated) workspace-plan request to an HTTP
 * status + JSON body. Kept out of the route handler so it is unit-testable
 * without a running server.
 *
 * An unsafe/incomplete plan (missing binaries, path collisions, dangling
 * edges, a path re-validation failure) is still returned as 200 with
 * `safe: false` and a populated `problems` array - a required document is
 * never silently dropped, overwritten or renamed to route around a problem.
 */
export async function getWorkspacePlanHttpResult(
  actor: Actor | null,
  rootCadDocumentId: string,
  db: GetLatestDb,
  provider: StorageProvider,
): Promise<WorkspacePlanHttpResult> {
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
    const plan = await getWorkspacePlanForActor(
      actor,
      rootCadDocumentId,
      db,
      provider,
    );
    return { status: 200, body: plan };
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
