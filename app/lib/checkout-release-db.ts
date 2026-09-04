/**
 * Arch PDM - Undo Checkout + Admin Unlock: Prisma-shaped wiring (P3C-3).
 *
 * Binds the pure core (`app/lib/checkout-release-core.ts`) to Prisma and to
 * the authenticated actor. Deliberately does NOT import "server-only" and
 * takes `db` as a required parameter, mirroring `checkout-db.ts` /
 * `checkin-db.ts` exactly, so this module stays loadable by the plain Node
 * test runner with an in-memory fake database. The route / server surface
 * is `app/lib/checkout-release.ts`, a thin `server-only`-guarded shim.
 *
 * TENANT SCOPING: every query is filtered by `organizationId =
 * actor.organizationId`, taken only from the verified `Actor` the caller
 * passes in.
 *
 * CONCURRENCY: Undo Checkout, Admin Unlock and Check-In (`checkin-db.ts`)
 * all TERMINATE a checkout, and exactly one terminal operation may ever
 * consume a given active checkout. All three take the SAME
 * `SELECT ... FOR UPDATE` lock on the CadCheckout row via the shared
 * `lockActiveCadCheckout` (`app/lib/db-concurrency-db.ts`), inside a bounded
 * SERIALIZABLE transaction (`runSerializableTransaction`). Whichever
 * transaction acquires the lock first re-verifies the row, records its own
 * `CadCheckoutEvent`, and deletes the CadCheckout row, then commits; every
 * other transaction blocked on this SAME lock unblocks against the
 * POST-COMMIT snapshot, finds zero rows, and fails cleanly with
 * `NotCheckedOutError` - never a raw Prisma error, never two terminal
 * operations succeeding for the same checkout, never two audit events for
 * one release. Exhausting the bounded retry raises
 * `CheckoutReleaseConcurrencyConflictError` (409).
 *
 * AUDIT: the CadCheckoutEvent insert and the CadCheckout delete happen in
 * the SAME transaction as the lock/verification above - a rolled-back
 * transaction (any error, any race loss) can never leave a dangling event
 * or a deleted checkout with no matching event. See
 * `prisma/schema.prisma`'s CadCheckoutEvent model comment for the FK /
 * retention design (Restrict, never Cascade, so history outlives the
 * records it names).
 *
 * OWNERSHIP: Undo Checkout requires `actor` to be the checkout's owner -
 * re-verified fresh inside the lock, never trusting the pre-check alone.
 * Admin Unlock requires `actor.role === ADMIN` and works on ANY active
 * checkout regardless of who holds it (that is the entire point of an
 * admin override) - it does NOT additionally require ownership.
 *
 * LIFECYCLE: like checkout-db.ts / checkin-db.ts, this NEVER creates a
 * FileVersion, NEVER touches stored binaries, and NEVER reads or writes
 * ItemRevision / lifecycle / CadDependency.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { UserRole, CadCheckoutEventType } from "../generated/prisma/enums.ts";
import {
  lockActiveCadCheckout,
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import {
  CadDocumentNotFoundError,
  CheckoutOwnershipError,
  CheckoutReleaseConcurrencyConflictError,
  AdminUnlockRoleError,
  InvalidReasonError,
  NotCheckedOutError,
  UndoCheckoutRoleError,
  normalizeOptionalReason,
  normalizeRequiredReason,
  resolveHistoryLimit,
  type CheckoutHistoryEntry,
  type CheckoutReleaseResult,
} from "./checkout-release-core.ts";

export {
  CadDocumentNotFoundError,
  CheckoutOwnershipError,
  CheckoutReleaseConcurrencyConflictError,
  AdminUnlockRoleError,
  InvalidReasonError,
  NotCheckedOutError,
  UndoCheckoutRoleError,
};
export type { CheckoutHistoryEntry, CheckoutReleaseResult };

/** The slice of PrismaClient this module needs. */
export type CheckoutReleaseDb = Pick<
  PrismaClient,
  "cadDocument" | "cadCheckout" | "cadCheckoutEvent" | "$transaction"
>;

/** Mirrors checkout-db.ts's `actorCanCheckOut` (VIEWER is the only excluded
 *  role today) - duplicated, not imported, to keep bounded contexts
 *  independent and plain-Node-testable. */
function actorCanUndoCheckout(actor: Actor): boolean {
  return actor.role !== UserRole.VIEWER;
}

async function loadOwnershipConflict(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  checkedOutById: string,
): Promise<CheckoutOwnershipError> {
  const row = await tx.cadCheckout.findFirst({
    where: { id: checkoutId },
    select: { checkedOutBy: { select: { name: true, email: true } } },
  });
  return new CheckoutOwnershipError({
    checkedOutById,
    checkedOutByName: row?.checkedOutBy.name ?? "",
    checkedOutByEmail: row?.checkedOutBy.email ?? "",
  });
}

async function findCadDocument(
  db: CheckoutReleaseDb,
  organizationId: string,
  cadDocumentId: string,
): Promise<{ id: string } | null> {
  return db.cadDocument.findFirst({
    where: { id: cadDocumentId, organizationId },
    select: { id: true },
  });
}

/**
 * Release `cadDocumentId`'s active checkout on behalf of its OWNER (`actor`
 * must hold it).
 *
 * @throws UndoCheckoutRoleError if the actor's role cannot release a
 *   checkout (VIEWER).
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws NotCheckedOutError if there is no active checkout (never checked
 *   out, already released, or lost a concurrent race).
 * @throws CheckoutOwnershipError if a DIFFERENT actor holds the checkout.
 * @throws InvalidReasonError if `reasonInput` is present but invalid.
 * @throws CheckoutReleaseConcurrencyConflictError if the bounded
 *   SERIALIZABLE retry is exhausted.
 */
export async function undoCheckoutForActor(
  actor: Actor,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb,
): Promise<CheckoutReleaseResult> {
  if (!actorCanUndoCheckout(actor)) {
    throw new UndoCheckoutRoleError();
  }
  const reason = normalizeOptionalReason(reasonInput);

  const cadDocument = await findCadDocument(
    db,
    actor.organizationId,
    cadDocumentId,
  );
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  // Cheap, NON-authoritative pre-check: fail fast when there is obviously
  // nothing to undo. The AUTHORITATIVE decision is always the locked
  // re-check inside the transaction below.
  const precheck = await db.cadCheckout.findFirst({
    where: { organizationId: actor.organizationId, cadDocumentId: cadDocument.id },
    select: { id: true, checkedOutById: true },
  });
  if (!precheck) {
    throw new NotCheckedOutError();
  }
  if (precheck.checkedOutById !== actor.userId) {
    const holder = await db.cadCheckout.findFirst({
      where: { id: precheck.id },
      select: { checkedOutBy: { select: { name: true, email: true } } },
    });
    throw new CheckoutOwnershipError({
      checkedOutById: precheck.checkedOutById,
      checkedOutByName: holder?.checkedOutBy.name ?? "",
      checkedOutByEmail: holder?.checkedOutBy.email ?? "",
    });
  }

  try {
    return await runSerializableTransaction(db, async (tx) => {
      const locked = await lockActiveCadCheckout(
        tx,
        actor.organizationId,
        cadDocument.id,
      );
      if (!locked) {
        throw new NotCheckedOutError();
      }
      if (locked.checkedOutById !== actor.userId) {
        throw await loadOwnershipConflict(tx, locked.id, locked.checkedOutById);
      }

      const event = await tx.cadCheckoutEvent.create({
        data: {
          organizationId: actor.organizationId,
          cadDocumentId: cadDocument.id,
          checkoutId: locked.id,
          baseFileVersionId: locked.baseFileVersionId,
          checkoutOwnerId: locked.checkedOutById,
          actedById: actor.userId,
          eventType: CadCheckoutEventType.UNDO_CHECKOUT,
          checkedOutAt: locked.checkedOutAt,
          reason,
        },
        select: { id: true },
      });

      await tx.cadCheckout.delete({ where: { id: locked.id } });

      return {
        cadDocumentId: cadDocument.id,
        checkoutId: locked.id,
        baseFileVersionId: locked.baseFileVersionId,
        previousOwnerId: locked.checkedOutById,
        eventId: event.id,
        reason,
      };
    });
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      throw new CheckoutReleaseConcurrencyConflictError();
    }
    throw error;
  }
}

/**
 * Forcibly release `cadDocumentId`'s active checkout on behalf of an ADMIN,
 * regardless of who holds it.
 *
 * @throws AdminUnlockRoleError if `actor.role !== ADMIN`.
 * @throws InvalidReasonError if `reasonInput` is missing, empty, or invalid
 *   - a reason is REQUIRED for Admin Unlock.
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws NotCheckedOutError if there is no active checkout.
 * @throws CheckoutReleaseConcurrencyConflictError if the bounded
 *   SERIALIZABLE retry is exhausted.
 */
export async function adminUnlockCheckoutForActor(
  actor: Actor,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb,
): Promise<CheckoutReleaseResult> {
  if (actor.role !== UserRole.ADMIN) {
    throw new AdminUnlockRoleError();
  }
  // Validated BEFORE touching the database - a bad request should never
  // even attempt a lookup.
  const reason = normalizeRequiredReason(reasonInput);

  const cadDocument = await findCadDocument(
    db,
    actor.organizationId,
    cadDocumentId,
  );
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  const precheck = await db.cadCheckout.findFirst({
    where: { organizationId: actor.organizationId, cadDocumentId: cadDocument.id },
    select: { id: true },
  });
  if (!precheck) {
    throw new NotCheckedOutError();
  }

  try {
    return await runSerializableTransaction(db, async (tx) => {
      const locked = await lockActiveCadCheckout(
        tx,
        actor.organizationId,
        cadDocument.id,
      );
      if (!locked) {
        throw new NotCheckedOutError();
      }

      const event = await tx.cadCheckoutEvent.create({
        data: {
          organizationId: actor.organizationId,
          cadDocumentId: cadDocument.id,
          checkoutId: locked.id,
          baseFileVersionId: locked.baseFileVersionId,
          checkoutOwnerId: locked.checkedOutById,
          actedById: actor.userId,
          eventType: CadCheckoutEventType.ADMIN_UNLOCK,
          checkedOutAt: locked.checkedOutAt,
          reason,
        },
        select: { id: true },
      });

      await tx.cadCheckout.delete({ where: { id: locked.id } });

      return {
        cadDocumentId: cadDocument.id,
        checkoutId: locked.id,
        baseFileVersionId: locked.baseFileVersionId,
        previousOwnerId: locked.checkedOutById,
        eventId: event.id,
        reason,
      };
    });
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      throw new CheckoutReleaseConcurrencyConflictError();
    }
    throw error;
  }
}

/**
 * Bounded, newest-first checkout history for `cadDocumentId`, scoped to
 * `actor`'s organization. Read-only, never mutates anything.
 *
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 */
export async function getCheckoutHistoryForActor(
  actor: Actor,
  cadDocumentId: string,
  db: CheckoutReleaseDb,
  limitInput?: unknown,
): Promise<CheckoutHistoryEntry[]> {
  const cadDocument = await findCadDocument(
    db,
    actor.organizationId,
    cadDocumentId,
  );
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  const limit = resolveHistoryLimit(limitInput);

  const rows = await db.cadCheckoutEvent.findMany({
    where: {
      organizationId: actor.organizationId,
      cadDocumentId: cadDocument.id,
    },
    // occurredAt alone is not a stable sort key: DateTime(3) column
    // resolution means two events created within the same millisecond
    // (e.g. CHECKED_OUT immediately followed by a same-millisecond release
    // in a fast test/race) can tie. id DESC breaks the tie deterministically
    // (cuid()s are monotonically increasing per insert), so "newest first"
    // is well-defined even under a timestamp collision.
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      cadDocumentId: true,
      checkoutId: true,
      baseFileVersionId: true,
      checkoutOwnerId: true,
      actedById: true,
      eventType: true,
      checkedOutAt: true,
      occurredAt: true,
      reason: true,
      baseFileVersion: { select: { versionNumber: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    cadDocumentId: row.cadDocumentId,
    checkoutId: row.checkoutId,
    baseFileVersionId: row.baseFileVersionId,
    baseVersionNumber: row.baseFileVersion.versionNumber,
    checkoutOwnerId: row.checkoutOwnerId,
    actedById: row.actedById,
    eventType: row.eventType,
    checkedOutAt: row.checkedOutAt.toISOString(),
    occurredAt: row.occurredAt.toISOString(),
    reason: row.reason,
  }));
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CheckoutReleaseHttpResult {
  status: number;
  body: unknown;
}

function isValidCadDocumentId(cadDocumentId: string): boolean {
  return (
    typeof cadDocumentId === "string" &&
    cadDocumentId.length > 0 &&
    cadDocumentId.length <= 200
  );
}

function publicResult(result: CheckoutReleaseResult) {
  return {
    cadDocumentId: result.cadDocumentId,
    checkoutId: result.checkoutId,
    baseFileVersionId: result.baseFileVersionId,
    previousOwnerId: result.previousOwnerId,
    reason: result.reason,
  };
}

function mapReleaseError(error: unknown): CheckoutReleaseHttpResult {
  if (error instanceof InvalidReasonError) {
    return { status: 400, body: { error: error.message } };
  }
  if (error instanceof UndoCheckoutRoleError || error instanceof AdminUnlockRoleError) {
    return { status: 403, body: { error: error.message } };
  }
  if (error instanceof CadDocumentNotFoundError) {
    return { status: 404, body: { error: error.message } };
  }
  if (error instanceof NotCheckedOutError) {
    return { status: 409, body: { error: error.message } };
  }
  if (error instanceof CheckoutOwnershipError) {
    return {
      status: 403,
      body: {
        error: error.message,
        checkedOutBy: {
          name: error.checkedOutByName,
          email: error.checkedOutByEmail,
        },
      },
    };
  }
  if (error instanceof CheckoutReleaseConcurrencyConflictError) {
    return { status: 409, body: { error: error.message } };
  }
  throw error;
}

export async function undoCheckoutHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb,
): Promise<CheckoutReleaseHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidCadDocumentId(cadDocumentId)) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }

  try {
    const result = await undoCheckoutForActor(actor, cadDocumentId, reasonInput, db);
    return { status: 200, body: publicResult(result) };
  } catch (error) {
    return mapReleaseError(error);
  }
}

export async function adminUnlockHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  reasonInput: unknown,
  db: CheckoutReleaseDb,
): Promise<CheckoutReleaseHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidCadDocumentId(cadDocumentId)) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }

  try {
    const result = await adminUnlockCheckoutForActor(actor, cadDocumentId, reasonInput, db);
    return { status: 200, body: publicResult(result) };
  } catch (error) {
    return mapReleaseError(error);
  }
}

export async function getCheckoutHistoryHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  limitInput: unknown,
  db: CheckoutReleaseDb,
): Promise<CheckoutReleaseHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidCadDocumentId(cadDocumentId)) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }

  try {
    const entries = await getCheckoutHistoryForActor(actor, cadDocumentId, db, limitInput);
    return { status: 200, body: { entries } };
  } catch (error) {
    if (error instanceof CadDocumentNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    throw error;
  }
}
