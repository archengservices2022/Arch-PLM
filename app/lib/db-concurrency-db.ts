/**
 * Arch PDM - shared PostgreSQL row-locking / SERIALIZABLE-retry primitives
 * (P3C-2).
 *
 * Deliberately does NOT import "server-only" (only type-only `Prisma`
 * imports, erased at compile time), so it stays loadable by the plain Node
 * test runner - mirrors `checkout-db.ts` / `checkin-db.ts`.
 *
 * Extracted so `checkout-db.ts`, `checkin-db.ts`, `checkout-release-db.ts`
 * (P3C-3 Undo/Admin Unlock) and the direct-upload guard
 * (`upload-guard-db.ts`) share ONE implementation of:
 *   - `SELECT ... FOR UPDATE` on the CadDocument row (the cross-table mutex
 *     that serializes checkout acquisition against direct FileVersion
 *     upload - see `upload-guard-db.ts`'s module doc comment for why a
 *     CadDocument-row lock, not a CadCheckout-row lock, is the correct
 *     shared serialization point for THAT invariant);
 *   - `SELECT ... FOR UPDATE` on the CadCheckout row (the SAME shared
 *     serialization point between every operation that TERMINATES a
 *     checkout - Check-In, Undo Checkout, Admin Unlock - so exactly one of
 *     them can ever consume a given active checkout);
 *   - the bounded SERIALIZABLE-transaction retry loop, mirroring
 *     `runSerializable` / `isSerializationError` in `app/actions.ts`;
 *   - a SAFE way to signal "retries exhausted" that every caller converts
 *     into ITS OWN domain-level conflict error (never a raw Prisma error) -
 *     see each call site's `isSerializationError`/exhausted handling.
 */
import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";

/** Thrown by `runSerializableTransaction` only after every retry attempt was
 *  itself a genuine Postgres serialization/deadlock failure. Never carries
 *  Prisma internals - callers catch this and rethrow their own domain-level
 *  conflict error (e.g. `CheckInConcurrencyConflictError`), which maps to a
 *  controlled 409. This class is never returned to an HTTP caller directly. */
export class SerializableTransactionExhaustedError extends Error {
  constructor() {
    super(
      "Could not complete the operation due to concurrent changes, please retry",
    );
    this.name = "SerializableTransactionExhaustedError";
  }
}

/** Mirrors `app/actions.ts`'s `isSerializationError`, but via duck-typing
 *  (not `instanceof Prisma.PrismaClientKnownRequestError`) so this module
 *  never needs a runtime import from the generated Prisma client. */
export function isSerializationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  if (code === "P2034") {
    return true;
  }
  if (code === "P2010") {
    const meta = (error as { meta?: unknown }).meta;
    const pgCode =
      meta && typeof meta === "object" && "code" in meta
        ? (meta as { code: unknown }).code
        : undefined;
    return pgCode === "40001" || pgCode === "40P01";
  }
  return false;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Run `fn` inside a SERIALIZABLE transaction with a small bounded retry on
 * serialization/write-conflict failures. Every attempt re-runs the ENTIRE
 * callback (a fresh row lock + fresh reads), so a retry always observes a
 * current snapshot. Non-serialization errors (domain errors, other Prisma
 * errors) are never retried - they propagate immediately.
 *
 * @throws SerializableTransactionExhaustedError if every attempt failed with
 *   a genuine serialization/deadlock error. The caller MUST catch this and
 *   convert it to its own domain-level conflict - never let it (or a raw
 *   P2034/P2010) reach an HTTP response.
 */
export async function runSerializableTransaction<T>(
  db: Pick<PrismaClient, "$transaction">,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (error) {
      if (isSerializationError(error)) {
        if (attempt < maxAttempts) {
          continue;
        }
        throw new SerializableTransactionExhaustedError();
      }
      throw error;
    }
  }
  throw new SerializableTransactionExhaustedError();
}

export interface LockedCadDocument {
  id: string;
  organizationId: string;
}

/**
 * `SELECT ... FOR UPDATE` on the CadDocument row inside an open transaction.
 *
 * This is the SHARED serialization point between checkout acquisition
 * (`checkout-db.ts`) and direct FileVersion upload (`upload-guard-db.ts`):
 * neither operation touches the other's table directly (checkout inserts
 * into CadCheckout; upload inserts into FileVersion), so without a shared
 * mutex the two could interleave and violate exclusive-checkout semantics.
 * Both sides lock this SAME CadDocument row before making their
 * check-then-write decision, so whichever acquires the lock first commits
 * its entire decision before the other can even read the state it depends
 * on. Returns null when the document is not in the given tenant.
 *
 * Parameterised raw SQL - the `${...}` values are Prisma bind parameters,
 * not string interpolation.
 */
export async function lockCadDocumentForVersionMutation(
  tx: Prisma.TransactionClient,
  organizationId: string,
  cadDocumentId: string,
): Promise<LockedCadDocument | null> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; organizationId: string }>
  >`
    SELECT "id", "organizationId"
    FROM "CadDocument"
    WHERE "id" = ${cadDocumentId}
      AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export interface LockedCadCheckout {
  id: string;
  baseFileVersionId: string;
  checkedOutById: string;
  checkedOutAt: Date;
}

/**
 * `SELECT ... FOR UPDATE` on the CadCheckout row for (organizationId,
 * cadDocumentId) inside an open transaction - the SHARED serialization
 * point between every operation that TERMINATES an active checkout
 * (P3C-2 Check-In, P3C-3 Undo Checkout, P3C-3 Admin Unlock).
 *
 * Exactly one of these can ever consume a given checkout: whichever
 * transaction acquires this lock first re-verifies the row, deletes it (and
 * records its own audit event), and commits; every other transaction
 * blocked on this SAME lock unblocks against the POST-COMMIT snapshot, sees
 * zero rows, and fails cleanly (never a raw Prisma error, never a second
 * terminal operation on the same checkout). Returns null when no checkout
 * exists for this (tenant-scoped) document - callers must treat this as
 * "nothing to release", not retry it.
 *
 * Parameterised raw SQL - the `${...}` values are Prisma bind parameters,
 * not string interpolation.
 */
export async function lockActiveCadCheckout(
  tx: Prisma.TransactionClient,
  organizationId: string,
  cadDocumentId: string,
): Promise<LockedCadCheckout | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      baseFileVersionId: string;
      checkedOutById: string;
      checkedOutAt: Date;
    }>
  >`
    SELECT "id", "baseFileVersionId", "checkedOutById", "checkedOutAt"
    FROM "CadCheckout"
    WHERE "cadDocumentId" = ${cadDocumentId}
      AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}
