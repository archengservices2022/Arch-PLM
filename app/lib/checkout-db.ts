/**
 * Arch PDM - CAD Checkout: Prisma-shaped wiring (P3C-1).
 *
 * Binds the pure core (`app/lib/checkout-core.ts`) to Prisma and to the
 * authenticated actor. Deliberately does NOT import "server-only" and takes
 * `db` / `provider` as required parameters (no singleton defaults, no
 * side-effecting imports) - mirrors `app/lib/get-latest-db.ts` /
 * `app/lib/workspace-plan-db.ts` exactly, so this module stays loadable by
 * the plain Node test runner with an in-memory fake database. The route /
 * server surface is `app/lib/checkout.ts`, a thin `server-only`-guarded shim.
 *
 * TENANT SCOPING: every query below is filtered by `organizationId =
 * actor.organizationId`. The organization comes only from the verified
 * `Actor` the caller passes in - never from a route param, header or body -
 * so a caller can never see, create, or conflict against another tenant's
 * checkout.
 *
 * CONCURRENCY (actor vs actor): `CadCheckout` has a DATABASE-level unique
 * constraint on (organizationId, cadDocumentId) - see `prisma/schema.prisma`'s
 * model comment for the full reasoning. At most one checkout row can ever
 * exist per document. Two actors racing to check out the same document both
 * attempt `cadCheckout.create()`; Postgres's unique index lets exactly one
 * succeed. The loser's insert fails with a unique-constraint violation
 * (P2002), which this module turns into either an idempotent "you already
 * hold it" outcome (same actor) or a `CheckoutConflictError` naming the
 * other actor (different actor). This reconciliation is now defense-in-depth
 * (see below) rather than the primary mechanism.
 *
 * CONCURRENCY (checkout vs direct upload, P3C-2): the unique constraint above
 * only serializes two checkout ATTEMPTS against each other - it says nothing
 * about a concurrent direct FileVersion upload
 * (`POST .../file-versions`, guarded by `app/lib/upload-guard-db.ts`), which
 * writes to a completely different table. Without an additional shared mutex,
 * a checkout could capture `baseFileVersionId = V1` while a concurrent direct
 * upload independently creates V2, silently invalidating the checkout's
 * exclusivity the instant it is created. So the "resolve base version, then
 * create the checkout row" step below runs inside a SERIALIZABLE transaction
 * that first takes `SELECT ... FOR UPDATE` on the CadDocument row via
 * `lockCadDocumentForVersionMutation` (`app/lib/db-concurrency-db.ts`) - the
 * SAME lock direct upload takes before deciding whether a checkout blocks it.
 * Whichever side acquires the lock first fully commits its decision before
 * the other's lock acquisition can even proceed, so the two operations can
 * never interleave. Exhausting the bounded SERIALIZABLE retry under genuine
 * concurrent load raises `CheckoutConcurrencyConflictError` (409) - never a
 * raw Prisma/P2034 error.
 *
 * LIFECYCLE: this NEVER creates a FileVersion, and NEVER reads or writes
 * ItemRevision / lifecycle / CadDependency. A CadDocument's FileVersion
 * history is already independent of ItemRevision lifecycle in this
 * architecture today (see the TODO(release-snapshot) note above
 * `isUniqueConstraintError` in `app/actions.ts`: a CadDocument keeps
 * accepting new FileVersions even after an ItemRevision that references it
 * is RELEASED, because there is no release-baseline / version-pinning model
 * yet). Checkout follows that SAME existing boundary and does not consult
 * ItemRevision lifecycle at all - so it neither strengthens nor weakens the
 * immutability `advanceRevision` / `createCadDocument` /
 * `linkExistingCadDocumentToRevision` already enforce for ItemRevision
 * itself. Inventing a NEW lifecycle-aware rule for checkout specifically -
 * without a real release-baseline model behind it - would be inconsistent
 * with that existing, deliberate boundary, so this module does not add one.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { UserRole } from "../generated/prisma/enums.ts";
import {
  lockCadDocumentForVersionMutation,
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import type { StorageProvider } from "./storage-core.ts";
import {
  CadDocumentNotFoundError,
  CheckoutConcurrencyConflictError,
  CheckoutConflictError,
  CheckoutRoleError,
  DEFAULT_MAX_VERSIONS_SCANNED,
  NoValidFileVersionError,
  resolveLatestBinaryVersionForCheckout,
  type CheckoutRecord,
  type CheckoutRequestOutcome,
  type CheckoutStatus,
} from "./checkout-core.ts";

export {
  CadDocumentNotFoundError,
  CheckoutConcurrencyConflictError,
  CheckoutConflictError,
  CheckoutRoleError,
  NoValidFileVersionError,
};
export type { CheckoutRecord, CheckoutRequestOutcome, CheckoutStatus };

/** The slice of PrismaClient this module needs. Narrowed so tests can inject
 *  a lightweight in-memory fake with the same shape. Includes `$transaction`
 *  (P3C-2) for the CadDocument row lock shared with direct upload. */
export type CheckoutDb = Pick<
  PrismaClient,
  "cadDocument" | "fileVersion" | "cadCheckout" | "$transaction"
>;

/** Mirrors `app/lib/authz.ts`'s `PLM_WRITE_ROLES` / `assertCanMutate` (VIEWER
 *  is the only excluded role today) - duplicated, not imported, because
 *  authz.ts is server-only and this module must stay plain-Node-testable.
 *  Keep this in sync if the role matrix there ever changes. */
function actorCanCheckOut(actor: Actor): boolean {
  return actor.role !== UserRole.VIEWER;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

async function loadCheckoutRecord(
  db: CheckoutDb,
  organizationId: string,
  cadDocumentId: string,
): Promise<CheckoutRecord | null> {
  const row = await db.cadCheckout.findFirst({
    where: { organizationId, cadDocumentId },
    select: {
      id: true,
      cadDocumentId: true,
      baseFileVersionId: true,
      checkedOutById: true,
      checkedOutAt: true,
      note: true,
      baseFileVersion: { select: { versionNumber: true } },
      checkedOutBy: { select: { name: true, email: true } },
    },
  });
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    cadDocumentId: row.cadDocumentId,
    baseFileVersionId: row.baseFileVersionId,
    baseVersionNumber: row.baseFileVersion.versionNumber,
    checkedOutById: row.checkedOutById,
    checkedOutByName: row.checkedOutBy.name,
    checkedOutByEmail: row.checkedOutBy.email,
    checkedOutAt: row.checkedOutAt.toISOString(),
    note: row.note,
  };
}

/**
 * Request a checkout of `cadDocumentId` for `actor`.
 *
 * @throws CheckoutRoleError if the actor's role cannot check out (VIEWER).
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws NoValidFileVersionError if the document has no current
 *   binary-backed FileVersion to lock against.
 * @throws CheckoutConflictError if another actor already holds the checkout.
 */
export async function requestCheckoutForActor(
  actor: Actor,
  cadDocumentId: string,
  db: CheckoutDb,
  provider: StorageProvider,
): Promise<CheckoutRequestOutcome> {
  if (!actorCanCheckOut(actor)) {
    throw new CheckoutRoleError();
  }

  const cadDocument = await db.cadDocument.findFirst({
    where: { id: cadDocumentId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  // Common-path idempotency check: avoids a doomed insert attempt when a
  // checkout already exists. The P2002 handling below still covers the race
  // window between this read and the insert - it is not relied on alone.
  const existing = await loadCheckoutRecord(
    db,
    actor.organizationId,
    cadDocument.id,
  );
  if (existing) {
    if (existing.checkedOutById === actor.userId) {
      return { status: "already-mine", checkout: existing };
    }
    throw new CheckoutConflictError(existing);
  }

  // AUTHORITATIVE: resolve the base version and create the checkout row
  // inside ONE CadDocument-row-locked SERIALIZABLE transaction - the shared
  // mutex with direct upload (see the module doc comment above). The
  // pre-check above is a fast path only; everything here is re-verified
  // fresh, from inside the lock.
  try {
    return await runSerializableTransaction(db, async (tx) => {
      const lockedDoc = await lockCadDocumentForVersionMutation(
        tx,
        actor.organizationId,
        cadDocument.id,
      );
      if (!lockedDoc) {
        // The document existed a moment ago (checked above); treat a
        // vanished row the same way as never having found it.
        throw new CadDocumentNotFoundError();
      }

      const insideExisting = await loadCheckoutRecord(
        tx as unknown as CheckoutDb,
        actor.organizationId,
        cadDocument.id,
      );
      if (insideExisting) {
        if (insideExisting.checkedOutById === actor.userId) {
          return { status: "already-mine", checkout: insideExisting };
        }
        throw new CheckoutConflictError(insideExisting);
      }

      const resolution = await resolveLatestBinaryVersionForCheckout(
        cadDocument.id,
        {
          maxVersionsScanned: DEFAULT_MAX_VERSIONS_SCANNED,
          async loadVersionsNewestFirst(id) {
            const rows = await tx.fileVersion.findMany({
              where: {
                organizationId: actor.organizationId,
                cadDocumentId: id,
              },
              orderBy: { versionNumber: "desc" },
              take: DEFAULT_MAX_VERSIONS_SCANNED,
              select: {
                id: true,
                versionNumber: true,
                checksum: true,
                fileSize: true,
                storageKey: true,
              },
            });
            return rows.map((row) => ({
              id: row.id,
              versionNumber: row.versionNumber,
              checksum: row.checksum,
              fileSize: row.fileSize == null ? null : Number(row.fileSize),
              storageKey: row.storageKey,
            }));
          },
          async objectExists(storageKey) {
            return provider.exists(storageKey);
          },
        },
      );

      if (resolution.kind !== "ok") {
        throw new NoValidFileVersionError();
      }

      const created = await tx.cadCheckout.create({
        data: {
          organizationId: actor.organizationId,
          cadDocumentId: cadDocument.id,
          baseFileVersionId: resolution.row.id,
          checkedOutById: actor.userId,
        },
        select: {
          id: true,
          cadDocumentId: true,
          baseFileVersionId: true,
          checkedOutById: true,
          checkedOutAt: true,
          note: true,
          baseFileVersion: { select: { versionNumber: true } },
          checkedOutBy: { select: { name: true, email: true } },
        },
      });
      const record: CheckoutRecord = {
        id: created.id,
        cadDocumentId: created.cadDocumentId,
        baseFileVersionId: created.baseFileVersionId,
        baseVersionNumber: created.baseFileVersion.versionNumber,
        checkedOutById: created.checkedOutById,
        checkedOutByName: created.checkedOutBy.name,
        checkedOutByEmail: created.checkedOutBy.email,
        checkedOutAt: created.checkedOutAt.toISOString(),
        note: created.note,
      };
      return { status: "created", checkout: record };
    });
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      throw new CheckoutConcurrencyConflictError();
    }
    if (error instanceof CheckoutConflictError || error instanceof NoValidFileVersionError) {
      throw error;
    }
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    // Defense-in-depth: the CadDocument row lock should make this
    // unreachable in practice (the in-lock re-check above catches an
    // existing checkout before any insert is attempted), but never mask a
    // genuine unique-constraint violation if it somehow still occurs.
    // Lost the race: exactly one of the racing requests wins the insert;
    // reconcile against whoever that turned out to be.
    const afterRace = await loadCheckoutRecord(
      db,
      actor.organizationId,
      cadDocument.id,
    );
    if (!afterRace) {
      // Should not happen (a unique-constraint violation means a row
      // exists), but never mask the original error if it somehow does.
      throw error;
    }
    if (afterRace.checkedOutById === actor.userId) {
      return { status: "already-mine", checkout: afterRace };
    }
    throw new CheckoutConflictError(afterRace);
  }
}

/**
 * Read-only checkout status for `cadDocumentId`, scoped to `actor`'s
 * organization. Never mutates anything.
 *
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 */
export async function getCheckoutStatusForActor(
  actor: Actor,
  cadDocumentId: string,
  db: CheckoutDb,
): Promise<CheckoutStatus> {
  const cadDocument = await db.cadDocument.findFirst({
    where: { id: cadDocumentId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  const existing = await loadCheckoutRecord(
    db,
    actor.organizationId,
    cadDocument.id,
  );
  if (!existing) {
    return { state: "available" };
  }
  if (existing.checkedOutById === actor.userId) {
    return { state: "mine", checkout: existing };
  }
  return { state: "locked", checkout: existing };
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CheckoutHttpResult {
  status: number;
  body: unknown;
}

function publicCheckout(record: CheckoutRecord) {
  return {
    id: record.id,
    cadDocumentId: record.cadDocumentId,
    baseFileVersionId: record.baseFileVersionId,
    baseVersionNumber: record.baseVersionNumber,
    checkedOutById: record.checkedOutById,
    checkedOutBy: {
      name: record.checkedOutByName,
      email: record.checkedOutByEmail,
    },
    checkedOutAt: record.checkedOutAt,
    note: record.note,
  };
}

function isValidCadDocumentId(cadDocumentId: string): boolean {
  return (
    typeof cadDocumentId === "string" &&
    cadDocumentId.length > 0 &&
    cadDocumentId.length <= 200
  );
}

/**
 * Map an authenticated (or unauthenticated) checkout REQUEST to an HTTP
 * status + JSON body. Kept out of the route handler so it is unit-testable
 * without a running server.
 */
export async function requestCheckoutHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  db: CheckoutDb,
  provider: StorageProvider,
): Promise<CheckoutHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidCadDocumentId(cadDocumentId)) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }

  try {
    const outcome = await requestCheckoutForActor(
      actor,
      cadDocumentId,
      db,
      provider,
    );
    return {
      status: outcome.status === "created" ? 201 : 200,
      body: {
        status: outcome.status,
        checkout: publicCheckout(outcome.checkout),
      },
    };
  } catch (error) {
    if (error instanceof CheckoutRoleError) {
      return { status: 403, body: { error: error.message } };
    }
    if (error instanceof CadDocumentNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    if (error instanceof NoValidFileVersionError) {
      return { status: 422, body: { error: error.message } };
    }
    if (error instanceof CheckoutConflictError) {
      return {
        status: 409,
        body: {
          error: error.message,
          checkout: publicCheckout(error.checkout),
        },
      };
    }
    if (error instanceof CheckoutConcurrencyConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}

/**
 * Map an authenticated (or unauthenticated) checkout STATUS request to an
 * HTTP status + JSON body.
 */
export async function getCheckoutStatusHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  db: CheckoutDb,
): Promise<CheckoutHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidCadDocumentId(cadDocumentId)) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }

  try {
    const result = await getCheckoutStatusForActor(actor, cadDocumentId, db);
    if (result.state === "available") {
      return { status: 200, body: { state: "available" } };
    }
    return {
      status: 200,
      body: { state: result.state, checkout: publicCheckout(result.checkout) },
    };
  } catch (error) {
    if (error instanceof CadDocumentNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    throw error;
  }
}
