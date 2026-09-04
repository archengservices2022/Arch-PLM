/**
 * Arch PDM - direct FileVersion upload vs. exclusive checkout guard
 * (P3C-2, Codex HIGH follow-up).
 *
 * Deliberately does NOT import "server-only" and takes `db` / `provider` as
 * required parameters (no singleton defaults), mirroring `checkout-db.ts` /
 * `checkin-db.ts`, so this module stays loadable by the plain Node test
 * runner with an in-memory fake database. The route surface is
 * `app/lib/storage.ts`, whose `storeCadFileVersion` is now a thin wrapper
 * around `storeCadFileVersionForActor` below.
 *
 * POLICY: `POST /api/cad-documents/:id/file-versions` (the P3A "direct
 * upload" endpoint) predates Check-In (P3C-2) and has no knowledge of
 * CadCheckout. Left unguarded, it could create a new FileVersion for a
 * document that is currently checked out - including by the checkout OWNER
 * themself - silently bypassing the controlled Check-In editing model this
 * milestone establishes. The rule enforced here:
 *
 *   - no active checkout on the document -> direct upload is allowed
 *     (this preserves bootstrap/initial FileVersion creation and any other
 *     legitimate unmanaged-upload use, unchanged from before P3C-2);
 *   - an active checkout exists -> direct upload is REJECTED (409),
 *     regardless of who the actor is, INCLUDING the checkout's own owner.
 *     New versions for a checked-out document must go through Check-In.
 *
 * CONCURRENCY: this is the OTHER half of the shared mutex described in
 * `checkout-db.ts`'s module comment. "Check checkout -> see none -> upload"
 * as two separate steps would leave a window where a concurrent checkout
 * acquisition could commit in between, so the checkout-existence check and
 * the FileVersion insert happen inside ONE SERIALIZABLE transaction that
 * first takes `SELECT ... FOR UPDATE` on the CadDocument row
 * (`lockCadDocumentForVersionMutation`, `app/lib/db-concurrency-db.ts`) -
 * the SAME lock checkout acquisition takes before resolving its base
 * version and creating the CadCheckout row. Whichever side acquires the
 * lock first fully commits its decision (create the checkout, or create the
 * FileVersion) before the other's lock acquisition can even proceed, so a
 * checkout can never be silently invalidated by a direct upload racing its
 * creation, and a direct upload can never slip in between a checkout's
 * resolve-base and create steps. Exhausting the bounded SERIALIZABLE retry
 * under genuine concurrent load raises `UploadConcurrencyConflictError`
 * (409) - never a raw Prisma/P2034 error - and, per `uploadCadFileVersion`'s
 * existing compensation, the promoted binary is deleted and no FileVersion
 * row is created.
 *
 * STORAGE: reuses `uploadCadFileVersion` from `app/lib/storage-core.ts`
 * verbatim - the SAME P3A staging/promotion/compensation architecture
 * Check-In reuses. No second storage implementation.
 *
 * LIFECYCLE: this NEVER reads or writes ItemRevision / lifecycle /
 * CadDependency.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import type { Readable } from "node:stream";
import {
  lockCadDocumentForVersionMutation,
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import {
  EmptyUploadError,
  UploadTooLargeError,
  normalizeOriginalFileName,
  uploadCadFileVersion,
  type StorageProvider,
  type UploadedFileVersion,
} from "./storage-core.ts";

export class CadDocumentNotFoundError extends Error {
  constructor() {
    super("CAD document not found in your organization");
    this.name = "CadDocumentNotFoundError";
  }
}

/** Thrown whenever an active checkout exists for the document, regardless
 *  of whether the uploading actor is the checkout's own owner. Carries no
 *  lock details (unlike CheckoutConflictError) - a direct-upload caller does
 *  not need to know who holds the checkout, only that Check-In is required. */
export class ActiveCheckoutBlocksUploadError extends Error {
  constructor() {
    super(
      "This CAD document is checked out; use Check-In to add a new version",
    );
    this.name = "ActiveCheckoutBlocksUploadError";
  }
}

/** Thrown only after the CadDocument-row-locked SERIALIZABLE transaction
 *  exhausted its bounded retries under genuine concurrent load. Never
 *  carries Prisma internals. */
export class UploadConcurrencyConflictError extends Error {
  constructor() {
    super("Could not complete upload due to concurrent changes, please retry");
    this.name = "UploadConcurrencyConflictError";
  }
}

export { EmptyUploadError, UploadTooLargeError };

/** The slice of PrismaClient this module needs. Narrowed so tests can inject
 *  a lightweight in-memory fake with the same shape. */
export type UploadGuardDb = Pick<
  PrismaClient,
  "cadDocument" | "fileVersion" | "cadCheckout" | "$transaction"
>;

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * Store an uploaded CAD binary as the next FileVersion for `cadDocumentId`,
 * refusing when an active checkout exists (see the module doc comment).
 *
 * @throws CadDocumentNotFoundError if the document doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws ActiveCheckoutBlocksUploadError if any active checkout exists for
 *   the document - including one held by `actor` themself.
 * @throws UploadConcurrencyConflictError if the bounded SERIALIZABLE retry
 *   under the shared CadDocument lock is exhausted.
 * @throws UploadTooLargeError / EmptyUploadError from the storage layer.
 */
export async function storeCadFileVersionForActor(
  actor: Actor,
  cadDocumentId: string,
  source: Readable,
  originalFileNameHeader: string | null | undefined,
  maxBytes: number,
  db: UploadGuardDb,
  provider: StorageProvider,
): Promise<UploadedFileVersion> {
  const cadDocument = await db.cadDocument.findFirst({
    where: { id: cadDocumentId, organizationId: actor.organizationId },
    select: { id: true, fileName: true },
  });
  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  // Cheap, NON-authoritative pre-check: fail fast, before consuming a
  // potentially large upload, when a checkout is obviously already active.
  // The AUTHORITATIVE decision is always the locked re-check inside
  // persistFileVersionRow below.
  const precheck = await db.cadCheckout.findFirst({
    where: { organizationId: actor.organizationId, cadDocumentId: cadDocument.id },
    select: { id: true },
  });
  if (precheck) {
    throw new ActiveCheckoutBlocksUploadError();
  }

  const originalFileName = normalizeOriginalFileName(
    originalFileNameHeader ?? cadDocument.fileName,
  );

  return uploadCadFileVersion(
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
      async persistFileVersionRow(input) {
        try {
          return await runSerializableTransaction(db, async (tx) => {
            const lockedDoc = await lockCadDocumentForVersionMutation(
              tx,
              actor.organizationId,
              cadDocument.id,
            );
            if (!lockedDoc) {
              throw new CadDocumentNotFoundError();
            }

            const activeCheckout = await tx.cadCheckout.findFirst({
              where: {
                organizationId: actor.organizationId,
                cadDocumentId: cadDocument.id,
              },
              select: { id: true },
            });
            if (activeCheckout) {
              throw new ActiveCheckoutBlocksUploadError();
            }

            return tx.fileVersion.create({
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
          });
        } catch (error) {
          if (error instanceof SerializableTransactionExhaustedError) {
            throw new UploadConcurrencyConflictError();
          }
          throw error;
        }
      },
      isVersionNumberConflict(error: unknown) {
        // ActiveCheckoutBlocksUploadError / UploadConcurrencyConflictError /
        // CadDocumentNotFoundError are NOT version conflicts - they
        // propagate straight out; uploadCadFileVersion compensates the
        // just-promoted object and rethrows without retrying.
        return isUniqueConstraintViolation(error);
      },
    },
  );
}
