import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import {
  copyDesignOperationStatusHttpResult as copyDesignOperationStatusHttpResultWith,
  CopyDesignOperationStatusNotFoundError,
  type CopyDesignOperationStatusDb,
  type CopyDesignOperationStatusHttpResult,
} from "@/app/lib/copy-design-operation-status-db";

/**
 * Server-only entry point for the P6D ROUND 3 Copy Design operation status
 * lookup (`GET /api/desktop/copy-design/operations/:operationId/status`).
 *
 * Thin shim: all domain logic lives in the pure
 * `copy-design-operation-status-core.ts`, and all Prisma-shaped query logic
 * lives in the plain (non-`server-only`) `copy-design-operation-status-db.ts`,
 * which is what the focused tests exercise directly with an in-memory fake
 * database. This module only supplies the real `prisma` client as the default.
 */

export { CopyDesignOperationStatusNotFoundError };
export type { CopyDesignOperationStatusHttpResult };

export async function copyDesignOperationStatusHttpResult(
  actor: Actor | null,
  operationId: string,
  db: CopyDesignOperationStatusDb = prisma,
): Promise<CopyDesignOperationStatusHttpResult> {
  return copyDesignOperationStatusHttpResultWith(actor, operationId, db);
}
