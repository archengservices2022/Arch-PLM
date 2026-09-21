import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { getStorageProvider } from "@/app/lib/storage";
import { resolveMaxUploadBytes, type StorageProvider } from "@/app/lib/storage-core";
import type { Readable } from "node:stream";
import {
  copyDesignMaterializeHttpResult as copyDesignMaterializeHttpResultWith,
  CopyDesignAlreadyMaterializedError,
  CopyDesignMaterializeCompensationFailedError,
  CopyDesignMaterializeConcurrencyConflictError,
  CopyDesignMaterializeEligibilityError,
  CopyDesignMaterializeIntegrityError,
  CopyDesignMaterializeInvalidStateError,
  CopyDesignMaterializeMismatchError,
  CopyDesignMaterializeRoleError,
  EmptyUploadError,
  UploadTooLargeError,
  type CopyDesignMaterializeDb,
  type CopyDesignMaterializeHttpResult,
} from "@/app/lib/copy-design-materialize-db";
import type { CopyDesignMaterializeRequestMeta } from "@/app/lib/copy-design-materialize-core";

/**
 * Server-only entry point for the P6C materialization bridge.
 *
 * Thin shim: all domain logic lives in the pure `copy-design-materialize-core.ts`,
 * and all Prisma-shaped query/transaction/storage logic lives in the plain
 * (non-`server-only`) `copy-design-materialize-db.ts`, which is what the
 * focused tests exercise directly with an in-memory fake database. This
 * module only supplies the real `prisma` client, storage provider, and
 * upload size limit as defaults.
 */

export {
  CopyDesignAlreadyMaterializedError,
  CopyDesignMaterializeCompensationFailedError,
  CopyDesignMaterializeConcurrencyConflictError,
  CopyDesignMaterializeEligibilityError,
  CopyDesignMaterializeIntegrityError,
  CopyDesignMaterializeInvalidStateError,
  CopyDesignMaterializeMismatchError,
  CopyDesignMaterializeRoleError,
  EmptyUploadError,
  UploadTooLargeError,
};
export type { CopyDesignMaterializeHttpResult };

export async function copyDesignMaterializeHttpResult(
  actor: Actor | null,
  meta: CopyDesignMaterializeRequestMeta,
  source: Readable | null,
  db: CopyDesignMaterializeDb = prisma,
  provider: StorageProvider = getStorageProvider(),
  maxBytes: number = resolveMaxUploadBytes(),
): Promise<CopyDesignMaterializeHttpResult> {
  return copyDesignMaterializeHttpResultWith(actor, meta, source, maxBytes, db, provider);
}
