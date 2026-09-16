import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import {
  applyCopyDesignOperationForActor as applyCopyDesignOperationForActorWith,
  copyDesignApplyHttpResult as copyDesignApplyHttpResultWith,
  CopyDesignConcurrencyConflictError,
  CopyDesignDestinationConflictError,
  CopyDesignIdempotencyConflictError,
  CopyDesignRoleError,
  CopyDesignSourceNotFoundError,
  CopyDesignValidationError,
  type CopyDesignApplyHttpResult,
  type CopyDesignApplyResultDto,
  type CopyDesignDb,
} from "@/app/lib/copy-design-lineage-db";

/**
 * Server-only entry point for Copy Design identity reservation + lineage
 * (P6B).
 *
 * Thin shim: all domain logic lives in the pure `copy-design-lineage-core.ts`,
 * and all Prisma-shaped query/transaction logic lives in the plain (non-
 * `server-only`) `copy-design-lineage-db.ts`, which is what the focused
 * tests exercise directly with an in-memory fake database and a fake actor.
 * This module only supplies the real `prisma` client as the default and
 * re-asserts the server-only boundary.
 */

export {
  CopyDesignConcurrencyConflictError,
  CopyDesignDestinationConflictError,
  CopyDesignIdempotencyConflictError,
  CopyDesignRoleError,
  CopyDesignSourceNotFoundError,
  CopyDesignValidationError,
};
export type { CopyDesignApplyHttpResult, CopyDesignApplyResultDto, CopyDesignDb };

export async function applyCopyDesignOperationForActor(
  actor: Actor,
  rawRequest: unknown,
  db: CopyDesignDb = prisma,
): Promise<CopyDesignApplyResultDto> {
  return applyCopyDesignOperationForActorWith(actor, rawRequest, db);
}

export async function copyDesignApplyHttpResult(
  actor: Actor | null,
  rawRequest: unknown,
  db: CopyDesignDb = prisma,
): Promise<CopyDesignApplyHttpResult> {
  return copyDesignApplyHttpResultWith(actor, rawRequest, db);
}
