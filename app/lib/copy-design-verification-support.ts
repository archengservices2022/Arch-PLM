import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import {
  copyDesignVerificationSupportHttpResult as copyDesignVerificationSupportHttpResultWith,
  CopyDesignOperationStatusNotFoundError,
  type CopyDesignVerificationSupportDb,
  type CopyDesignVerificationSupportHttpResult,
} from "@/app/lib/copy-design-verification-support-db";

/**
 * Server-only entry point for the P6E-A Copy Design verification-support
 * lookup (`GET /api/desktop/copy-design/operations/:operationId/verification-support`).
 *
 * Thin shim: all domain logic lives in the pure
 * `copy-design-verification-support-core.ts`, and all Prisma-shaped query
 * logic lives in the plain (non-`server-only`) `copy-design-verification-support-db.ts`,
 * which is what the focused tests exercise directly with an in-memory fake
 * database. This module only supplies the real `prisma` client as the default.
 */

export { CopyDesignOperationStatusNotFoundError };
export type { CopyDesignVerificationSupportHttpResult };

export async function copyDesignVerificationSupportHttpResult(
  actor: Actor | null,
  operationId: string,
  db: CopyDesignVerificationSupportDb = prisma,
): Promise<CopyDesignVerificationSupportHttpResult> {
  return copyDesignVerificationSupportHttpResultWith(actor, operationId, db);
}
