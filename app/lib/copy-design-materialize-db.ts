/**
 * Arch PLM - P6C server bridge: Prisma-shaped wiring for materializing the
 * FIRST FileVersion of a P6B-reserved Copy Design target.
 *
 * Deliberately does NOT import "server-only" and takes `db` / `provider` as
 * required parameters (no singleton defaults), mirroring `checkin-db.ts` /
 * `upload-guard-db.ts`, so this module stays loadable by the plain Node test
 * runner with an in-memory fake database. The server-only shim is
 * `app/lib/copy-design-materialize.ts`; the route surface is
 * `POST /api/desktop/copy-design/materialize/:cadDocumentId`.
 *
 * ELIGIBILITY (a single query proves ALL of these together - see
 * `loadEligibleReservedTarget`):
 *   1. the CadDocument exists in `actor.organizationId`;
 *   2. it is the NEW target of a CadCopyLineage row;
 *   3/5. that lineage's `copyDesignOperationId` exactly equals the caller's;
 *   6. the caller's `cadDocumentId` exactly equals the lineage's `newCadDocumentId`;
 *   7. the caller's `sourceCadDocumentId` exactly equals the lineage's own
 *      `sourceCadDocumentId` (proof of "the exact source lineage context",
 *      not just "some cadDocumentId a server once returned");
 *   8. the caller's declared `documentType` exactly equals the reserved
 *      CadDocument's own `documentType`.
 * Any failure - including a cross-tenant id, or a perfectly normal non-copy
 * CadDocument with no lineage row at all - surfaces as the SAME generic
 * `CopyDesignMaterializeEligibilityError` (404), never distinguished, never
 * leaking which specific condition failed.
 *
 * FILEVERSION STATE (Round 2, MEDIUM 1): condition 4 is "the reserved target
 * has ZERO FileVersions", NOT merely "no versionNumber 1 row" - a document
 * with, say, only a version 2 row (or a version 1 + version 2 pair) is an
 * invalid/malformed state for a reserved Copy Design target and must never
 * be treated as either "fresh" or "already replayable". `classifyFileVersionState`
 * loads EVERY FileVersion row for the target (both at the fast pre-check and
 * the authoritative locked re-check) and classifies it into exactly one of:
 *   - Empty: zero rows - eligible for first materialization;
 *   - ReplayCandidate: EXACTLY one row, and it is versionNumber 1 - a
 *     candidate for idempotent replay, subject to full stored-object
 *     integrity verification (see below) before replay is ever reported;
 *   - Malformed: anything else (only v2, v1+v2, duplicates, etc.) - ALWAYS a
 *     fail-closed `CopyDesignMaterializeInvalidStateError`, never a create,
 *     never a replay.
 *
 * CONCURRENCY: mirrors `upload-guard-db.ts` exactly - `SELECT ... FOR UPDATE`
 * on the CadDocument row (`lockCadDocumentForVersionMutation`) inside a
 * bounded SERIALIZABLE transaction, so two concurrent materialize requests
 * for the SAME reserved target can never both create "version 1". Whichever
 * transaction acquires the lock first commits (or definitively fails) before
 * the other's lock acquisition can even proceed.
 *
 * IDEMPOTENCY + STORED-OBJECT INTEGRITY (Round 2, HIGH 2): a ReplayCandidate
 * whose DB metadata (checksum/fileSize) matches the freshly staged upload is
 * NOT enough on its own to report success - the FileVersion row's metadata
 * could describe bytes that are no longer actually in storage (missing,
 * corrupted, silently altered). Before EVER reporting idempotent replay
 * success (at BOTH the fast pre-check and the locked/concurrent-winner
 * path), `verifyReplayIntegrity` re-hashes the EXISTING stored object via
 * `provider.hashObject` (the project's canonical stored-object integrity
 * primitive) and requires ALL THREE to agree: the actual stored bytes' own
 * hash/size, the FileVersion row's recorded checksum/fileSize, and the
 * freshly staged upload's own actual hash/size. Any disagreement - including
 * the stored object being missing entirely - throws
 * `CopyDesignMaterializeIntegrityError` and NEVER reports replay success;
 * the existing (possibly corrupt) object is never touched, and the freshly
 * staged bytes are never promoted over it (no overwrite, ever). If
 * FileVersion 1 exists with metadata that plainly differs from what was
 * just uploaded, this is a hard conflict (409) - never silently ignored,
 * never replaced. FileVersion 2+ is never created by this endpoint under any
 * circumstance - `isVersionNumberConflict`-style retries (as
 * `uploadCadFileVersion` uses for check-in/direct-upload) are deliberately
 * NOT used here, because "try the next number" is never a legitimate outcome
 * for a first-version-only endpoint.
 *
 * STORAGE: reuses the SAME primitives `uploadCadFileVersion` is built from
 * (`StorageProvider.stageStream` / `promoteStaged` / `discardStaged` /
 * `hashObject` / `delete`, `fileVersionStorageKey`, `newUploadNonce`) - not a
 * second storage implementation. `uploadCadFileVersion` itself is not reused
 * verbatim because its retry-on-version-conflict loop does not fit "exactly
 * version 1, idempotent-if-identical, otherwise conflict" semantics.
 *
 * COMPENSATION FAILURE (Round 2, MEDIUM 2): if this request's own promoted
 * object becomes orphaned (the transaction failed, or a concurrent winner
 * made it redundant) and deleting that orphan ALSO fails, this is NEVER
 * silently swallowed (no bare `.catch(() => {})`). It is surfaced as
 * `CopyDesignMaterializeCompensationFailedError`, which retains the exact
 * storage key + both the original failure (if any) and the cleanup failure
 * for SERVER-SIDE diagnostics only (`console.error`) - the HTTP mapping
 * never exposes the storage key or either error's raw detail to the client.
 * This is deliberately never a `finally`/`catch`-and-ignore: an operation
 * that cannot prove it left no orphan behind must never report anything
 * resembling a clean outcome. Compensation NEVER deletes any object's key
 * other than the one THIS request itself just promoted (a fresh,
 * uniquely-nonced key from `fileVersionStorageKey` - structurally never a
 * concurrent winner's own `storageKey`).
 *
 * LIFECYCLE: creates ONLY a FileVersion row. Never creates, updates, or
 * deletes CopyDesignOperation, CopyDesignOperationEntry, CadCopyLineage, the
 * source CadDocument, or any source FileVersion. Never touches ItemRevision,
 * ReleaseBaseline, CadCheckout, or CadDependency.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import type { Readable } from "node:stream";
import { UserRole } from "../generated/prisma/enums.ts";
import {
  lockCadDocumentForVersionMutation,
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import {
  EmptyUploadError,
  UploadTooLargeError,
  fileVersionStorageKey,
  newUploadNonce,
  normalizeOriginalFileName,
  type StorageProvider,
} from "./storage-core.ts";
import type { CopyDesignMaterializeRequestMeta, CopyDesignMaterializeResultDto } from "./copy-design-materialize-core.ts";

export { EmptyUploadError, UploadTooLargeError };

export class CopyDesignMaterializeRoleError extends Error {
  constructor() {
    super("Your role does not permit materializing a Copy Design target");
    this.name = "CopyDesignMaterializeRoleError";
  }
}

/** Thrown for ANY eligibility failure - missing document, wrong tenant, no
 *  lineage, wrong operation, wrong source, wrong document type. Deliberately
 *  generic and undifferentiated so a cross-tenant identifier, a non-copy
 *  document, and a genuinely malformed request all look identical. */
export class CopyDesignMaterializeEligibilityError extends Error {
  constructor() {
    super("This CAD document is not an eligible reserved Copy Design target in your organization");
    this.name = "CopyDesignMaterializeEligibilityError";
  }
}

/** FileVersion 1 already exists for this target AND differs (checksum or
 *  size) from what was just uploaded. Never overwritten, never replaced. */
export class CopyDesignAlreadyMaterializedError extends Error {
  constructor() {
    super("This Copy Design target already has a FileVersion that does not match the uploaded content");
    this.name = "CopyDesignAlreadyMaterializedError";
  }
}

/** Round 2, MEDIUM 1: the target's FileVersion state is neither "zero rows"
 *  nor "exactly one row, versionNumber 1" - e.g. only a version 2 row, or a
 *  version 1 + version 2 pair. This is an invalid state for a reserved Copy
 *  Design target and is ALWAYS fail-closed - never a create, never a
 *  replay. */
export class CopyDesignMaterializeInvalidStateError extends Error {
  constructor() {
    super("This Copy Design target is in an unexpected FileVersion state and cannot be materialized or replayed");
    this.name = "CopyDesignMaterializeInvalidStateError";
  }
}

/** Round 2, HIGH 2: the EXISTING stored object for a would-be idempotent
 *  replay could not be verified - missing, unreadable, or its actual bytes
 *  do not match the recorded FileVersion metadata (or the freshly staged
 *  upload). Replay is NEVER reported as successful in this case, and the
 *  existing (possibly corrupt) object is NEVER touched or overwritten.
 *  `diagnostic` is for SERVER-SIDE logging only - never sent to the client. */
export class CopyDesignMaterializeIntegrityError extends Error {
  readonly diagnostic: string;
  constructor(diagnostic: string) {
    super("The existing stored file for this Copy Design target could not be verified");
    this.name = "CopyDesignMaterializeIntegrityError";
    this.diagnostic = diagnostic;
  }
}

/** Round 2, MEDIUM 2: this request's own promoted storage object is
 *  orphaned (the transaction failed, or a concurrent winner made it
 *  redundant) AND deleting that orphan also failed. Never silently
 *  swallowed. `storageKey` / `originalError` / `cleanupError` are for
 *  SERVER-SIDE diagnostics only - never sent to the client as-is. */
export class CopyDesignMaterializeCompensationFailedError extends Error {
  readonly storageKey: string;
  readonly originalError: unknown;
  readonly cleanupError: unknown;
  constructor(storageKey: string, originalError: unknown, cleanupError: unknown) {
    super(
      originalError
        ? "Materialization failed and the orphaned storage object could not be cleaned up automatically - manual cleanup required"
        : "A redundant storage object from a losing concurrent materialization attempt could not be cleaned up automatically - manual cleanup required",
    );
    this.name = "CopyDesignMaterializeCompensationFailedError";
    this.storageKey = storageKey;
    this.originalError = originalError;
    this.cleanupError = cleanupError;
  }
}

/** The ACTUAL uploaded bytes (hashed/measured server-side) do not match what
 *  the caller declared it was sending - rejected before any DB mutation. */
export class CopyDesignMaterializeMismatchError extends Error {
  readonly field: "sha256" | "fileSize";
  constructor(field: "sha256" | "fileSize") {
    super(`The uploaded content's ${field === "sha256" ? "SHA-256" : "file size"} does not match the declared value`);
    this.name = "CopyDesignMaterializeMismatchError";
    this.field = field;
  }
}

export class CopyDesignMaterializeConcurrencyConflictError extends Error {
  constructor() {
    super("Could not complete materialization due to concurrent changes, please retry");
    this.name = "CopyDesignMaterializeConcurrencyConflictError";
  }
}

/** Mirrors `checkin-db.ts`'s `actorCanCheckIn` (VIEWER is the only excluded
 *  role) - duplicated, not imported (authz.ts is server-only). */
function actorCanMaterialize(actor: Actor): boolean {
  return actor.role !== UserRole.VIEWER;
}

/** The slice of PrismaClient this module needs. Narrowed so tests can inject
 *  a lightweight in-memory fake with the same shape. */
export type CopyDesignMaterializeDb = Pick<PrismaClient, "cadCopyLineage" | "fileVersion" | "$transaction">;

interface EligibleTarget {
  cadDocumentId: string;
}

/** The ONE query that proves eligibility conditions 1/2/3/5/6/7/8 together -
 *  see the module doc comment. Returns `null` for ANY failure. */
async function loadEligibleReservedTarget(
  db: Pick<CopyDesignMaterializeDb, "cadCopyLineage">,
  organizationId: string,
  meta: CopyDesignMaterializeRequestMeta,
): Promise<EligibleTarget | null> {
  const lineage = await db.cadCopyLineage.findFirst({
    where: {
      organizationId,
      newCadDocumentId: meta.cadDocumentId,
      sourceCadDocumentId: meta.sourceCadDocumentId,
      copyDesignOperationId: meta.copyDesignOperationId,
    },
    select: {
      newCadDocument: { select: { id: true, documentType: true } },
    },
  });
  if (!lineage) {
    return null;
  }
  if (lineage.newCadDocument.documentType !== meta.documentType) {
    return null;
  }
  return { cadDocumentId: lineage.newCadDocument.id };
}

interface ExistingVersionRow {
  id: string;
  versionNumber: number;
  originalFileName: string;
  fileSize: bigint | null;
  checksum: string | null;
  storageKey: string;
}

const EXISTING_VERSION_SELECT = {
  id: true,
  versionNumber: true,
  originalFileName: true,
  fileSize: true,
  checksum: true,
  storageKey: true,
} as const;

function toResultDto(
  row: { id: string; versionNumber: number; originalFileName: string; fileSize: bigint | null; checksum: string | null },
  cadDocumentId: string,
  copyDesignOperationId: string,
): CopyDesignMaterializeResultDto {
  return {
    cadDocumentId,
    fileVersionId: row.id,
    versionNumber: row.versionNumber,
    fileName: row.originalFileName,
    fileSize: Number(row.fileSize ?? 0),
    sha256: row.checksum ?? "",
    copyDesignOperationId,
  };
}

type FileVersionState =
  | { kind: "empty" }
  | { kind: "replayCandidate"; row: ExistingVersionRow }
  | { kind: "malformed" };

/**
 * Round 2, MEDIUM 1: authoritatively classifies a target's COMPLETE
 * FileVersion set - not merely "is there a versionNumber 1 row" - into
 * exactly one of Empty / ReplayCandidate / Malformed. See the module doc
 * comment for the full state table.
 */
async function classifyFileVersionState(
  db: Pick<CopyDesignMaterializeDb, "fileVersion">,
  organizationId: string,
  cadDocumentId: string,
): Promise<FileVersionState> {
  const versions = await db.fileVersion.findMany({
    where: { organizationId, cadDocumentId },
    select: EXISTING_VERSION_SELECT,
  });
  if (versions.length === 0) {
    return { kind: "empty" };
  }
  if (versions.length === 1 && versions[0]!.versionNumber === 1) {
    return { kind: "replayCandidate", row: versions[0]! };
  }
  return { kind: "malformed" };
}

/**
 * Round 2, HIGH 2: proves the EXISTING stored object for a replay candidate
 * is genuinely healthy and matches BOTH the FileVersion row's own recorded
 * metadata AND the freshly staged upload's actual bytes, before replay is
 * EVER reported as successful.
 *
 * @throws CopyDesignMaterializeIntegrityError if the stored object is
 *   missing/unreadable, or its actual hash/size disagrees with either the
 *   recorded metadata or the freshly staged upload.
 */
async function verifyReplayIntegrity(
  provider: StorageProvider,
  row: ExistingVersionRow,
  staged: { sha256: string; size: number },
): Promise<void> {
  let actual: { sha256: string; size: number };
  try {
    actual = await provider.hashObject(row.storageKey);
  } catch (error) {
    console.error(
      `P6C materialize: existing stored object is missing or unreadable (storageKey=${row.storageKey}, fileVersionId=${row.id})`,
      error,
    );
    throw new CopyDesignMaterializeIntegrityError(
      `stored object missing/unreadable for fileVersionId=${row.id}, storageKey=${row.storageKey}`,
    );
  }
  const recordedSize = row.fileSize === null ? null : Number(row.fileSize);
  if (actual.sha256 !== row.checksum || actual.size !== recordedSize) {
    console.error(
      `P6C materialize: stored object does not match recorded FileVersion metadata ` +
        `(storageKey=${row.storageKey}, fileVersionId=${row.id}, recorded=${row.checksum}/${recordedSize}, actual=${actual.sha256}/${actual.size})`,
    );
    throw new CopyDesignMaterializeIntegrityError(
      `stored object does not match recorded metadata for fileVersionId=${row.id}, storageKey=${row.storageKey}`,
    );
  }
  if (actual.sha256 !== staged.sha256 || actual.size !== staged.size) {
    console.error(
      `P6C materialize: stored object does not match the freshly staged upload ` +
        `(storageKey=${row.storageKey}, fileVersionId=${row.id}, actual=${actual.sha256}/${actual.size}, staged=${staged.sha256}/${staged.size})`,
    );
    throw new CopyDesignMaterializeIntegrityError(
      `stored object does not match the freshly staged upload for fileVersionId=${row.id}, storageKey=${row.storageKey}`,
    );
  }
}

/** Internal control-flow signal only - never escapes this module. Thrown
 *  inside the locked transaction when a CONCURRENT winner's FileVersion 1
 *  turns out to be byte-identical to this request's own upload (AND its
 *  stored object independently verifies healthy), so the caller can report
 *  idempotent success instead of a conflict. */
class IdempotentReplaySignal extends Error {
  readonly row: ExistingVersionRow;
  constructor(row: ExistingVersionRow) {
    super("idempotent replay");
    this.row = row;
  }
}

/** FileVersion's `@@unique([cadDocumentId, versionNumber])`, by its EXACT
 *  column set (array-shaped `meta.target`) and its EXACT index name
 *  (string-shaped) - see
 *  20260903135817_add_cad_documents_and_file_versions/migration.sql. */
const FILE_VERSION_NUMBER_UNIQUE = {
  fields: ["cadDocumentId", "versionNumber"],
  indexName: "FileVersion_cadDocumentId_versionNumber_key",
} as const;

/**
 * Milestone 3A, D-1: true iff `error` is a P2002 on EXACTLY the FileVersion
 * version-number unique constraint. Under SERIALIZABLE, the losing request
 * of a concurrent first-version race can read a snapshot that predates the
 * winner's commit (so it sees no version 1) and collide only at INSERT -
 * which PostgreSQL may report as a unique violation (P2002) instead of a
 * retryable serialization failure. Any other P2002 - a different
 * constraint, a subset/superset column set, or an unreadable target - is
 * NOT this conflict and must never be reclassified.
 */
function isFileVersionNumberConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || (error as { code?: unknown }).code !== "P2002") {
    return false;
  }
  const meta = (error as { meta?: unknown }).meta;
  const target =
    meta && typeof meta === "object" && "target" in meta ? (meta as { target: unknown }).target : undefined;
  if (typeof target === "string") {
    return target === FILE_VERSION_NUMBER_UNIQUE.indexName;
  }
  return (
    Array.isArray(target) &&
    target.length === FILE_VERSION_NUMBER_UNIQUE.fields.length &&
    FILE_VERSION_NUMBER_UNIQUE.fields.every((field) => target.includes(field))
  );
}

/**
 * Materialize FileVersion 1 for a P6B-reserved Copy Design target.
 *
 * @throws CopyDesignMaterializeRoleError (403) if the actor's role cannot mutate.
 * @throws CopyDesignMaterializeEligibilityError (404) for any eligibility failure.
 * @throws CopyDesignMaterializeInvalidStateError (409) if the target's
 *   FileVersion state is neither "zero rows" nor "exactly one, versionNumber 1".
 * @throws CopyDesignAlreadyMaterializedError (409) if FileVersion 1 already
 *   exists with different content - including when a concurrent winner
 *   commits it first and this request only collides at INSERT (D-1).
 * @throws CopyDesignMaterializeIntegrityError (500) if an existing
 *   FileVersion 1's ACTUAL stored object cannot be verified as healthy and
 *   matching before replay would be reported.
 * @throws CopyDesignMaterializeMismatchError (400) if the actual uploaded
 *   bytes do not match the caller's declared sha256/fileSize.
 * @throws CopyDesignMaterializeConcurrencyConflictError (409) if the bounded
 *   SERIALIZABLE retry is exhausted.
 * @throws CopyDesignMaterializeCompensationFailedError (500) if this
 *   request's own orphaned promoted object could not be cleaned up.
 * @throws UploadTooLargeError / EmptyUploadError from the storage layer.
 */
export async function materializeFirstFileVersionForActor(
  actor: Actor,
  meta: CopyDesignMaterializeRequestMeta,
  source: Readable,
  maxBytes: number,
  db: CopyDesignMaterializeDb,
  provider: StorageProvider,
): Promise<CopyDesignMaterializeResultDto & { idempotentReplay: boolean }> {
  if (!actorCanMaterialize(actor)) {
    throw new CopyDesignMaterializeRoleError();
  }

  // Cheap, NON-authoritative pre-check: fail fast, before consuming a
  // potentially large upload, when this is obviously not an eligible
  // reserved target. The AUTHORITATIVE decision is always the locked
  // re-check inside the transaction below.
  const precheck = await loadEligibleReservedTarget(db, actor.organizationId, meta);
  if (!precheck) {
    throw new CopyDesignMaterializeEligibilityError();
  }

  const staged = await provider.stageStream(source, { maxBytes });
  try {
    if (staged.size === 0) {
      throw new EmptyUploadError();
    }

    // "Do not trust metadata without validating uploaded bytes": the ACTUAL
    // server-measured bytes must match what the caller CLAIMED it was
    // sending, before anything else happens.
    if (staged.size !== meta.expectedFileSize) {
      throw new CopyDesignMaterializeMismatchError("fileSize");
    }
    if (staged.sha256 !== meta.expectedSha256) {
      throw new CopyDesignMaterializeMismatchError("sha256");
    }

    // Fast, non-authoritative state pre-check - the AUTHORITATIVE decision
    // is always the locked re-check inside the transaction below. Round 2,
    // MEDIUM 1: classifies the COMPLETE FileVersion set, not merely "is
    // there a version 1 row".
    const precheckState = await classifyFileVersionState(db, actor.organizationId, meta.cadDocumentId);
    if (precheckState.kind === "malformed") {
      throw new CopyDesignMaterializeInvalidStateError();
    }
    if (precheckState.kind === "replayCandidate") {
      if (precheckState.row.checksum !== staged.sha256 || Number(precheckState.row.fileSize) !== staged.size) {
        throw new CopyDesignAlreadyMaterializedError();
      }
      // Round 2, HIGH 2: metadata matching is NOT sufficient - prove the
      // ACTUAL stored bytes are healthy and agree before reporting replay.
      await verifyReplayIntegrity(provider, precheckState.row, staged);
      return { ...toResultDto(precheckState.row, meta.cadDocumentId, meta.copyDesignOperationId), idempotentReplay: true };
    }

    const originalFileName = normalizeOriginalFileName(meta.originalFileName);
    const storageKey = fileVersionStorageKey({
      organizationId: actor.organizationId,
      cadDocumentId: meta.cadDocumentId,
      versionNumber: 1,
      uploadNonce: newUploadNonce(),
    });

    await provider.promoteStaged(staged, storageKey);

    try {
      const row = await runSerializableTransaction(db, async (tx) => {
        const locked = await lockCadDocumentForVersionMutation(tx, actor.organizationId, meta.cadDocumentId);
        if (!locked) {
          throw new CopyDesignMaterializeEligibilityError();
        }

        // Re-verify the COMPLETE eligibility inside the lock - the world may
        // have changed since the pre-check (defense in depth; no realistic
        // path un-reserves a lineage row today, but this is never trusted
        // blindly).
        const stillEligible = await loadEligibleReservedTarget(tx, actor.organizationId, meta);
        if (!stillEligible) {
          throw new CopyDesignMaterializeEligibilityError();
        }

        const state = await classifyFileVersionState(tx, actor.organizationId, meta.cadDocumentId);
        if (state.kind === "malformed") {
          throw new CopyDesignMaterializeInvalidStateError();
        }
        if (state.kind === "replayCandidate") {
          if (state.row.checksum !== staged.sha256 || Number(state.row.fileSize) !== staged.size) {
            throw new CopyDesignAlreadyMaterializedError();
          }
          // A concurrent winner committed first. Its stored object must
          // independently verify healthy before WE report replay success -
          // never trust its DB row metadata alone, even for the winner.
          await verifyReplayIntegrity(provider, state.row, staged);
          throw new IdempotentReplaySignal(state.row);
        }

        return tx.fileVersion.create({
          data: {
            organizationId: actor.organizationId,
            cadDocumentId: meta.cadDocumentId,
            createdById: actor.userId,
            versionNumber: 1,
            originalFileName,
            storageKey,
            fileSize: BigInt(staged.size),
            checksum: staged.sha256,
          },
          select: EXISTING_VERSION_SELECT,
        });
      });

      return { ...toResultDto(row, meta.cadDocumentId, meta.copyDesignOperationId), idempotentReplay: false };
    } catch (error) {
      // Promotion succeeded but the transaction did not commit a NEW row for
      // THIS upload (lost a race, hit a conflict, or genuinely failed) ->
      // this attempt's own promoted object is always orphaned - remove it.
      // Round 2, MEDIUM 2: a cleanup failure here is NEVER silently
      // swallowed, on ANY path - including the idempotent-replay-signal
      // path, where the object is merely redundant rather than a symptom of
      // failure, but an un-cleanable orphan still needs surfacing either way.
      try {
        await provider.delete(storageKey);
      } catch (cleanupError) {
        throw new CopyDesignMaterializeCompensationFailedError(
          storageKey,
          error instanceof IdempotentReplaySignal ? null : error,
          cleanupError,
        );
      }

      if (error instanceof IdempotentReplaySignal) {
        return { ...toResultDto(error.row, meta.cadDocumentId, meta.copyDesignOperationId), idempotentReplay: true };
      }
      if (error instanceof SerializableTransactionExhaustedError) {
        throw new CopyDesignMaterializeConcurrencyConflictError();
      }
      if (isFileVersionNumberConflict(error)) {
        // D-1: a concurrent winner committed FileVersion 1 after this
        // transaction's snapshot. Re-read the now-committed state and
        // resolve it exactly like the in-transaction replayCandidate branch.
        // Nothing visible (or anything unexpected) -> the original error.
        const committed = await classifyFileVersionState(db, actor.organizationId, meta.cadDocumentId);
        if (committed.kind === "malformed") {
          throw new CopyDesignMaterializeInvalidStateError();
        }
        if (committed.kind === "replayCandidate") {
          if (committed.row.checksum !== staged.sha256 || Number(committed.row.fileSize) !== staged.size) {
            throw new CopyDesignAlreadyMaterializedError();
          }
          await verifyReplayIntegrity(provider, committed.row, staged);
          return { ...toResultDto(committed.row, meta.cadDocumentId, meta.copyDesignOperationId), idempotentReplay: true };
        }
      }
      throw error;
    }
  } finally {
    await provider.discardStaged(staged).catch(() => {});
  }
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CopyDesignMaterializeHttpResult {
  status: number;
  body: unknown;
}

export async function copyDesignMaterializeHttpResult(
  actor: Actor | null,
  meta: CopyDesignMaterializeRequestMeta,
  source: Readable | null,
  maxBytes: number,
  db: CopyDesignMaterializeDb,
  provider: StorageProvider,
): Promise<CopyDesignMaterializeHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!source) {
    return { status: 400, body: { error: "Empty upload" } };
  }

  try {
    const result = await materializeFirstFileVersionForActor(actor, meta, source, maxBytes, db, provider);
    const { idempotentReplay, ...dto } = result;
    return { status: idempotentReplay ? 200 : 201, body: dto };
  } catch (error) {
    if (error instanceof CopyDesignMaterializeRoleError) {
      return { status: 403, body: { error: error.message } };
    }
    if (error instanceof CopyDesignMaterializeEligibilityError) {
      return { status: 404, body: { error: error.message } };
    }
    if (error instanceof CopyDesignAlreadyMaterializedError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof CopyDesignMaterializeInvalidStateError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof CopyDesignMaterializeMismatchError) {
      return { status: 400, body: { error: error.message } };
    }
    if (error instanceof CopyDesignMaterializeConcurrencyConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof CopyDesignMaterializeIntegrityError) {
      // `error.diagnostic` (storage key / recorded vs. actual hash) is
      // SERVER-SIDE only - already logged by verifyReplayIntegrity via
      // console.error; the client only ever sees the generic message.
      return { status: 500, body: { error: error.message } };
    }
    if (error instanceof CopyDesignMaterializeCompensationFailedError) {
      // Round 2, MEDIUM 2: never claim a clean rollback. The storage key and
      // underlying original/cleanup errors are SERVER-SIDE diagnostics only.
      console.error(
        `P6C materialize: compensation failed for storageKey=${error.storageKey}`,
        { originalError: error.originalError, cleanupError: error.cleanupError },
      );
      return {
        status: 500,
        body: { error: "Materialization could not be fully completed or cleaned up automatically. Contact support." },
      };
    }
    if (error instanceof UploadTooLargeError) {
      return { status: 413, body: { error: "File exceeds the maximum upload size" } };
    }
    if (error instanceof EmptyUploadError) {
      return { status: 400, body: { error: "Empty upload" } };
    }
    throw error;
  }
}
