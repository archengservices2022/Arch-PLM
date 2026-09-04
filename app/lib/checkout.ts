import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { getStorageProvider } from "@/app/lib/storage";
import type { StorageProvider } from "@/app/lib/storage-core";
import {
  requestCheckoutForActor as requestCheckoutForActorWith,
  getCheckoutStatusForActor as getCheckoutStatusForActorWith,
  requestCheckoutHttpResult as requestCheckoutHttpResultWith,
  getCheckoutStatusHttpResult as getCheckoutStatusHttpResultWith,
  CadDocumentNotFoundError,
  CheckoutConflictError,
  CheckoutRoleError,
  NoValidFileVersionError,
  type CheckoutDb,
  type CheckoutHttpResult,
  type CheckoutRecord,
  type CheckoutRequestOutcome,
  type CheckoutStatus,
} from "@/app/lib/checkout-db";

/**
 * Server-only entry point for CAD Checkout (P3C-1).
 *
 * This is a thin shim: all domain logic lives in the pure `checkout-core.ts`,
 * and all Prisma-shaped query logic + tenant scoping + concurrency handling
 * lives in the plain (non-`server-only`) `checkout-db.ts`, which is what the
 * focused tests exercise directly with an in-memory fake database and a fake
 * actor. This module only supplies the real `prisma` client and storage
 * provider as defaults and re-asserts the server-only boundary.
 */

export {
  CadDocumentNotFoundError,
  CheckoutConflictError,
  CheckoutRoleError,
  NoValidFileVersionError,
};
export type {
  CheckoutDb,
  CheckoutHttpResult,
  CheckoutRecord,
  CheckoutRequestOutcome,
  CheckoutStatus,
};

export async function requestCheckoutForActor(
  actor: Actor,
  cadDocumentId: string,
  db: CheckoutDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<CheckoutRequestOutcome> {
  return requestCheckoutForActorWith(actor, cadDocumentId, db, provider);
}

export async function getCheckoutStatusForActor(
  actor: Actor,
  cadDocumentId: string,
  db: CheckoutDb = prisma,
): Promise<CheckoutStatus> {
  return getCheckoutStatusForActorWith(actor, cadDocumentId, db);
}

export async function requestCheckoutHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  db: CheckoutDb = prisma,
  provider: StorageProvider = getStorageProvider(),
): Promise<CheckoutHttpResult> {
  return requestCheckoutHttpResultWith(actor, cadDocumentId, db, provider);
}

export async function getCheckoutStatusHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  db: CheckoutDb = prisma,
): Promise<CheckoutHttpResult> {
  return getCheckoutStatusHttpResultWith(actor, cadDocumentId, db);
}
