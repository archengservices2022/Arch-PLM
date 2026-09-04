/**
 * Arch PDM - CAD Check-In: Prisma-shaped wiring (P3C-2).
 *
 * Binds the pure core (`app/lib/checkin-core.ts`) to Prisma, to the
 * authenticated actor, and to the EXISTING P3A storage orchestration
 * (`uploadCadFileVersion` in `app/lib/storage-core.ts`) - reused verbatim,
 * not reimplemented. Deliberately does NOT import "server-only" and takes
 * `db` / `provider` as required parameters, mirroring `app/lib/checkout-db.ts`
 * exactly, so this module stays loadable by the plain Node test runner with
 * an in-memory fake database. The route / server surface is
 * `app/lib/checkin.ts`, a thin `server-only`-guarded shim.
 *
 * TENANT SCOPING: every query is filtered by `organizationId =
 * actor.organizationId`, taken only from the verified `Actor` the caller
 * passes in.
 *
 * CONCURRENCY (the core design problem of this milestone): unlike checkout
 * (serialized primarily by a DB unique constraint, plus - since P3C-2 - a
 * CadDocument row lock shared with direct upload; see checkout-db.ts's
 * module comment), check-in must atomically "verify a CadCheckout row still
 * matches expectations, then delete it while creating a FileVersion". That
 * is not a shape a unique index alone can serialize. Instead,
 * `persistFileVersionRow` below (used as `uploadCadFileVersion`'s
 * `deps.persistFileVersionRow`) opens its OWN `SELECT ... FOR UPDATE` +
 * SERIALIZABLE transaction via the SHARED `runSerializableTransaction` /
 * `lockActiveCadCheckout` primitives in `app/lib/db-concurrency-db.ts`
 * (mirroring `lockItemRevisionForCadMutation` / `runSerializable` in
 * `app/actions.ts`). `lockActiveCadCheckout` locks the SAME CadCheckout row
 * that P3C-3's Undo Checkout and Admin Unlock also lock - see that
 * function's doc comment - so exactly one of Check-In / Undo / Admin Unlock
 * can ever consume a given checkout, regardless of which two race:
 *
 *   1. `SELECT ... FOR UPDATE` the CadCheckout row for
 *      (organizationId, cadDocumentId). This IS the serialization point: a
 *      second, concurrent terminal operation for the SAME document blocks
 *      here until the first transaction commits or rolls back.
 *   2. Re-verify (inside the lock, from a fresh read) that the checkout
 *      still exists, is still owned by `actor`, and that the document's
 *      current usable FileVersion (via the SHARED resolver in
 *      `file-version-resolution-core.ts` - see below) still equals the
 *      checkout's recorded base (stale-base defense in depth).
 *   3. Only then insert the FileVersion row, record a CHECKED_IN
 *      `CadCheckoutEvent` (P3C-3 durable history - see
 *      `prisma/schema.prisma`'s model comment), and delete the CadCheckout
 *      row - all in the SAME transaction.
 *
 * When the winner commits, the checkout row is gone. The loser's blocked
 * `SELECT ... FOR UPDATE` unblocks against the post-commit snapshot, finds
 * zero rows, and fails cleanly with `NotCheckedOutError` - never a raw
 * Prisma error, never a second FileVersion, never an orphaned lock, never a
 * CHECKED_IN event for a check-in that didn't actually happen.
 *
 * EXHAUSTED RETRIES (Codex HIGH finding, P3C-2 follow-up): if every attempt
 * of the bounded SERIALIZABLE retry fails with a genuine Postgres
 * serialization/deadlock conflict, `runSerializableTransaction` throws
 * `SerializableTransactionExhaustedError` - a marker that carries no Prisma
 * internals. `persistFileVersionRow` catches it immediately and rethrows
 * `CheckInConcurrencyConflictError` (mapped to 409 below), which
 * `uploadCadFileVersion`'s `isVersionNumberConflict` correctly does NOT
 * recognize as a version conflict, so it compensates (deletes the just-
 * promoted object, since the failed transaction never reached the DELETE of
 * the checkout row) and rethrows without retrying further. Net effect: the
 * checkout is provably untouched (the transaction that failed never
 * committed anything), no FileVersion row exists, no orphaned binary
 * remains, and the caller sees one controlled 409 - never a raw P2034.
 *
 * VERSION RESOLUTION (Codex MEDIUM finding, P3C-2 follow-up): the stale-base
 * check now calls the SAME `resolveCurrentFileVersion` algorithm Get Latest
 * and Checkout use (`app/lib/file-version-resolution-core.ts`), instead of
 * comparing against the raw numerically-newest FileVersion row. This closes
 * a semantic drift: the raw-newest comparison did not skip a
 * metadata-incomplete row or check binary existence, so it could disagree
 * with what Checkout/Get Latest consider "current" for the same document.
 *
 * STORAGE (binary bytes are staged/promoted OUTSIDE this transaction -
 * object storage and PostgreSQL are not one transaction): `checkInForActor`
 * calls `uploadCadFileVersion` exactly as `storeCadFileVersion` in
 * `app/lib/storage.ts` does. Its EXISTING "promote succeeded, DB failed ->
 * delete the orphaned object" compensation fires automatically whenever
 * `persistFileVersionRow` throws for ANY reason (a losing race, a stale
 * base, an ownership mismatch, an exhausted-retry conflict, or a genuine DB
 * error) - no new compensation logic is needed here.
 *
 * WHY THE STALE-BASE CHECK IS NOT PURELY PARANOID: the direct-upload
 * endpoint (`POST /api/cad-documents/:id/file-versions`) is now guarded
 * (`app/lib/upload-guard-db.ts`, P3C-2) against writing while a checkout is
 * active - so this is no longer the only defense against that specific gap.
 * It remains as defense in depth (e.g. against any future write path that
 * forgets the guard) and is the ONLY thing that would catch a document
 * somehow reaching an inconsistent state some other way.
 *
 * LIFECYCLE: this NEVER reads or writes ItemRevision / lifecycle /
 * CadDependency, matching checkout-db.ts's existing boundary.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import type { Readable } from "node:stream";
import { UserRole, CadCheckoutEventType } from "../generated/prisma/enums.ts";
import {
  lockActiveCadCheckout,
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import {
  DEFAULT_MAX_VERSIONS_SCANNED,
  resolveCurrentFileVersion,
} from "./file-version-resolution-core.ts";
import {
  EmptyUploadError,
  UploadTooLargeError,
  normalizeOriginalFileName,
  uploadCadFileVersion,
  type PersistFileVersionInput,
  type StorageProvider,
} from "./storage-core.ts";
import {
  CadDocumentNotFoundError,
  CheckInConcurrencyConflictError,
  CheckInRoleError,
  CheckInVersionRaceError,
  CheckoutOwnershipError,
  NotCheckedOutError,
  StaleBaseError,
  type CheckInResult,
} from "./checkin-core.ts";

export {
  CadDocumentNotFoundError,
  CheckInConcurrencyConflictError,
  CheckInRoleError,
  CheckInVersionRaceError,
  CheckoutOwnershipError,
  NotCheckedOutError,
  StaleBaseError,
};
export { EmptyUploadError, UploadTooLargeError };
export type { CheckInResult };

/** The slice of PrismaClient this module needs. Narrowed so tests can inject
 *  a lightweight in-memory fake with the same shape. Includes `$transaction`
 *  (unlike CheckoutDb) because check-in's serialization point is a
 *  row-locked transaction, not a unique-constraint insert race. */
export type CheckInDb = Pick<
  PrismaClient,
  "cadDocument" | "fileVersion" | "cadCheckout" | "cadCheckoutEvent" | "$transaction"
>;

/** Mirrors checkout-db.ts's `actorCanCheckOut` (VIEWER is the only excluded
 *  role today) - duplicated, not imported, to keep bounded contexts
 *  independent and plain-Node-testable. */
function actorCanCheckIn(actor: Actor): boolean {
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

/**
 * Check in `cadDocumentId`'s active checkout for `actor`, uploading `source`
 * as the new FileVersion.
 *
 * @throws CheckInRoleError if the actor's role cannot check in (VIEWER).
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws NotCheckedOutError if there is no active checkout (never checked
 *   out, already checked in, or lost a concurrent check-in race).
 * @throws CheckoutOwnershipError if a DIFFERENT actor holds the checkout.
 * @throws StaleBaseError if the document's current newest FileVersion no
 *   longer matches the checkout's recorded base.
 * @throws UploadTooLargeError / EmptyUploadError from the storage layer.
 */
export async function checkInForActor(
  actor: Actor,
  cadDocumentId: string,
  source: Readable,
  maxBytes: number,
  originalFileNameHeader: string | null | undefined,
  db: CheckInDb,
  provider: StorageProvider,
): Promise<CheckInResult> {
  if (!actorCanCheckIn(actor)) {
    throw new CheckInRoleError();
  }

  const cadDocument = await db.cadDocument.findFirst({
    where: { id: cadDocumentId, organizationId: actor.organizationId },
    select: { id: true, fileName: true },
  });
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  // Cheap, NON-authoritative pre-check: fail fast, before consuming a
  // potentially large upload, when there is obviously no active checkout to
  // check in against. The AUTHORITATIVE decision is always the locked
  // re-check inside persistFileVersionRow below, regardless of what this
  // sees - a benign race between the two is fine.
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

  const originalFileName = normalizeOriginalFileName(
    originalFileNameHeader ?? cadDocument.fileName,
  );

  const uploaded = await uploadCadFileVersion(
    {
      organizationId: actor.organizationId,
      cadDocumentId: cadDocument.id,
      actorUserId: actor.userId,
      source,
      maxBytes,
      originalFileName,
    },
    {
      provider,
      async allocateNextVersionNumber() {
        // A non-authoritative candidate, used only to build the storage key
        // BEFORE promotion. The authoritative number is re-derived inside
        // the lock in persistFileVersionRow below.
        const latest = await db.fileVersion.findFirst({
          where: {
            organizationId: actor.organizationId,
            cadDocumentId: cadDocument.id,
          },
          orderBy: { versionNumber: "desc" },
          select: { versionNumber: true },
        });
        return (latest?.versionNumber ?? 0) + 1;
      },
      async persistFileVersionRow(input: PersistFileVersionInput) {
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
              throw await loadOwnershipConflict(
                tx,
                locked.id,
                locked.checkedOutById,
              );
            }

            // SHARED semantics with Get Latest / Checkout (P3C-2): newest
            // metadata-complete row, no fallback to an older still-present
            // binary. Anything other than "ok, and it's exactly the
            // checkout's recorded base" is stale - including
            // missing-version/missing-binary, which would mean the
            // document's own base version somehow stopped being usable
            // since checkout began.
            const resolution = await resolveCurrentFileVersion(
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
            if (
              resolution.kind !== "ok" ||
              resolution.row.id !== locked.baseFileVersionId
            ) {
              throw new StaleBaseError(
                locked.baseFileVersionId,
                resolution.kind === "ok" ? resolution.row.id : null,
              );
            }

            // Version-NUMBER allocation is deliberately a SEPARATE concern
            // from staleness above: it must skip past ANY existing row's
            // versionNumber - including a metadata-incomplete one the shared
            // resolver correctly ignored for "what is current" - to avoid a
            // duplicate-versionNumber collision. Using the resolved (skip-
            // incomplete) row's versionNumber here instead would understate
            // the next number whenever an incomplete row already occupies
            // it. Defense in depth only, recognized by isVersionNumberConflict
            // so uploadCadFileVersion's existing retry-with-a-fresh-candidate
            // loop handles it if this ever actually diverges.
            const maxRow = await tx.fileVersion.findFirst({
              where: {
                organizationId: actor.organizationId,
                cadDocumentId: cadDocument.id,
              },
              orderBy: { versionNumber: "desc" },
              select: { versionNumber: true },
            });
            const nextVersionNumber = (maxRow?.versionNumber ?? 0) + 1;
            if (input.versionNumber !== nextVersionNumber) {
              throw new CheckInVersionRaceError();
            }

            const created = await tx.fileVersion.create({
              data: {
                organizationId: input.organizationId,
                cadDocumentId: input.cadDocumentId,
                createdById: input.createdById,
                versionNumber: input.versionNumber,
                originalFileName: input.originalFileName,
                storageKey: input.storageKey,
                fileSize: BigInt(input.fileSize),
                checksum: input.checksum,
              },
              select: { id: true, versionNumber: true },
            });

            // Durable history (P3C-3): recorded in the SAME transaction as
            // the FileVersion insert and the checkout delete - a failed
            // check-in (this transaction rolling back) can never leave a
            // CHECKED_IN event behind, and a successful one can never skip
            // it.
            await tx.cadCheckoutEvent.create({
              data: {
                organizationId: actor.organizationId,
                cadDocumentId: cadDocument.id,
                checkoutId: locked.id,
                baseFileVersionId: locked.baseFileVersionId,
                checkoutOwnerId: locked.checkedOutById,
                actedById: actor.userId,
                eventType: CadCheckoutEventType.CHECKED_IN,
                checkedOutAt: locked.checkedOutAt,
              },
            });

            await tx.cadCheckout.delete({ where: { id: locked.id } });

            return { id: created.id, versionNumber: created.versionNumber };
          });
        } catch (error) {
          if (error instanceof SerializableTransactionExhaustedError) {
            throw new CheckInConcurrencyConflictError();
          }
          throw error;
        }
      },
      isVersionNumberConflict(error: unknown) {
        return (
          error instanceof CheckInVersionRaceError ||
          isUniqueConstraintViolation(error)
        );
      },
    },
  );

  return {
    fileVersionId: uploaded.fileVersionId,
    cadDocumentId: cadDocument.id,
    versionNumber: uploaded.versionNumber,
    originalFileName,
    storageKey: uploaded.storageKey,
    fileSize: uploaded.fileSize,
    checksum: uploaded.checksum,
    createdById: actor.userId,
  };
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CheckInHttpResult {
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

/**
 * Map an authenticated (or unauthenticated) check-in REQUEST to an HTTP
 * status + JSON body. Kept out of the route handler so it is unit-testable
 * without a running server.
 */
export async function checkInHttpResult(
  actor: Actor | null,
  cadDocumentId: string,
  source: Readable | null,
  originalFileName: string | null,
  maxBytes: number,
  db: CheckInDb,
  provider: StorageProvider,
): Promise<CheckInHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidCadDocumentId(cadDocumentId)) {
    return { status: 400, body: { error: "Invalid CAD document id" } };
  }
  if (!source) {
    return { status: 400, body: { error: "Request body is empty" } };
  }

  try {
    const result = await checkInForActor(
      actor,
      cadDocumentId,
      source,
      maxBytes,
      originalFileName,
      db,
      provider,
    );
    return { status: 201, body: result };
  } catch (error) {
    if (error instanceof CheckInRoleError) {
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
        status: 409,
        body: {
          error: error.message,
          checkedOutBy: {
            name: error.checkedOutByName,
            email: error.checkedOutByEmail,
          },
        },
      };
    }
    if (error instanceof StaleBaseError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof CheckInConcurrencyConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof UploadTooLargeError) {
      return { status: 413, body: { error: error.message } };
    }
    if (error instanceof EmptyUploadError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}
