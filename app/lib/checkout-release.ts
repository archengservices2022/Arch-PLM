import "server-only";

import type { Actor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import {
  undoCheckoutForActor as undoCheckoutForActorWith,
  adminUnlockCheckoutForActor as adminUnlockCheckoutForActorWith,
  getCheckoutHistoryForActor as getCheckoutHistoryForActorWith,
  undoCheckoutHttpResult as undoCheckoutHttpResultWith,
  adminUnlockHttpResult as adminUnlockHttpResultWith,
  getCheckoutHistoryHttpResult as getCheckoutHistoryHttpResultWith,
  AdminUnlockRoleError,
  CadDocumentNotFoundError,
  CheckoutOwnershipError,
  CheckoutReleaseConcurrencyConflictError,
  InvalidReasonError,
  NotCheckedOutError,
  UndoCheckoutRoleError,
  type CheckoutHistoryEntry,
  type CheckoutReleaseDb,
  type CheckoutReleaseHttpResult,
  type CheckoutReleaseResult,
} from "@/app/lib/checkout-release-db";

/**
 * Server-only entry point for Undo Checkout / Admin Unlock / checkout
 * history (P3C-3).
 *
 * This is a thin shim: all domain logic lives in the pure
 * `checkout-release-core.ts`, and all Prisma-shaped query/transaction/
 * concurrency logic lives in the plain (non-`server-only`)
 * `checkout-release-db.ts`, which is what the focused tests exercise
 * directly with an in-memory fake database. This module only supplies the
 * real `prisma` client as a default and re-asserts the server-only boundary.
 */

export {
  AdminUnlockRoleError,
  CadDocumentNotFoundError,
  CheckoutOwnershipError,
  CheckoutReleaseConcurrencyConflictError,
  InvalidReasonError,
  NotCheckedOutError,
  UndoCheckoutRoleError,
};
export type { CheckoutHistoryEntry, CheckoutReleaseDb, CheckoutReleaseHttpResult, CheckoutReleaseResult };

export async function undoCheckoutForActor(
  actor: Actor,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb = prisma,
): Promise<CheckoutReleaseResult> {
  return undoCheckoutForActorWith(actor, cadDocumentId, reasonInput, db);
}

export async function adminUnlockCheckoutForActor(
  actor: Actor,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb = prisma,
): Promise<CheckoutReleaseResult> {
  return adminUnlockCheckoutForActorWith(actor, cadDocumentId, reasonInput, db);
}

export async function getCheckoutHistoryForActor(
  actor: Actor,
  cadDocumentId: string,
  limitInput?: unknown,
  db: CheckoutReleaseDb = prisma,
): Promise<CheckoutHistoryEntry[]> {
  return getCheckoutHistoryForActorWith(actor, cadDocumentId, db, limitInput);
}

export async function undoCheckoutHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb = prisma,
): Promise<CheckoutReleaseHttpResult> {
  return undoCheckoutHttpResultWith(actor, cadDocumentId, reasonInput, db);
}

export async function adminUnlockHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb = prisma,
): Promise<CheckoutReleaseHttpResult> {
  return adminUnlockHttpResultWith(actor, cadDocumentId, reasonInput, db);
}

export async function getCheckoutHistoryHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  limitInput: unknown,
  db: CheckoutReleaseDb = prisma,
): Promise<CheckoutReleaseHttpResult> {
  return getCheckoutHistoryHttpResultWith(actor, cadDocumentId, limitInput, db);
}
