import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { getStorageProvider } from "@/app/lib/storage";
import { resolveMaxUploadBytes, type StorageProvider } from "@/app/lib/storage-core";
import type { Readable } from "node:stream";
import {
  checkInForActor as checkInForActorWith,
  checkInHttpResult as checkInHttpResultWith,
  CadDocumentNotFoundError,
  CheckInConcurrencyConflictError,
  CheckInRoleError,
  CheckoutOwnershipError,
  NotCheckedOutError,
  StaleBaseError,
  type CheckInDb,
  type CheckInHttpResult,
  type CheckInResult,
} from "@/app/lib/checkin-db";

/**
 * Server-only entry point for CAD Check-In (P3C-2).
 *
 * This is a thin shim: all domain logic lives in the pure `checkin-core.ts`,
 * and all Prisma-shaped query/transaction/concurrency logic lives in the
 * plain (non-`server-only`) `checkin-db.ts`, which is what the focused tests
 * exercise directly with an in-memory fake database and a fake actor. This
 * module only supplies the real `prisma` client, storage provider, and
 * upload size limit as defaults, and re-asserts the server-only boundary.
 */

export {
  CadDocumentNotFoundError,
  CheckInConcurrencyConflictError,
  CheckInRoleError,
  CheckoutOwnershipError,
  NotCheckedOutError,
  StaleBaseError,
};
export type { CheckInDb, CheckInHttpResult, CheckInResult };

export async function checkInForActor(
  actor: Actor,
  cadDocumentId: string,
  source: Readable,
  originalFileName: string | null | undefined,
  db: CheckInDb = prisma,
  provider: StorageProvider = getStorageProvider(),
  maxBytes: number = resolveMaxUploadBytes(),
): Promise<CheckInResult> {
  return checkInForActorWith(
    actor,
    cadDocumentId,
    source,
    maxBytes,
    originalFileName,
    db,
    provider,
  );
}

export async function checkInHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  source: Readable | null,
  originalFileName: string | null,
  db: CheckInDb = prisma,
  provider: StorageProvider = getStorageProvider(),
  maxBytes: number = resolveMaxUploadBytes(),
): Promise<CheckInHttpResult> {
  return checkInHttpResultWith(
    actor,
    cadDocumentId,
    source,
    originalFileName,
    maxBytes,
    db,
    provider,
  );
}
