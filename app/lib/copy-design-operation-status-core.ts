/**
 * Arch PLM - P6D ROUND 3, HIGH fix (item D): the authoritative, dedicated,
 * READ-ONLY Copy Design operation status lookup (provider-agnostic core).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only request-shape
 * validation and response DTO types.
 *
 * WHY THIS EXISTS: CAD Connect's Inventor-side RESUME logic previously
 * inferred an operation entry's materialization state from
 * `GET /api/desktop/cad-documents/latest-versions` - a generic "does this
 * CadDocument have a recognized latest FileVersion" lookup never designed to
 * distinguish "reserved but not yet materialized" (zero FileVersion rows,
 * expected for a fresh reservation) from "unknown/malformed/communication
 * failure" (also, from that endpoint's point of view, "not recognized"). Both
 * looked identical, which made a safe RESUME decision impossible. This
 * endpoint instead reports, for EVERY entry of ONE specific
 * `CopyDesignOperation` the caller already knows the id of, an EXPLICIT
 * server-derived state - PENDING vs. MATERIALIZED vs. INVALID (COPY) or
 * REUSED (REUSE) - so those states can never be collapsed into each other,
 * and any HTTP/network/protocol failure is a genuine transport failure the
 * caller must fail closed on, never a disguised "pending".
 *
 * SCOPE: strictly READ-ONLY. Never creates, updates, or deletes anything -
 * no FileVersion, no CopyDesignOperation, no CopyDesignOperationEntry, no
 * CadCopyLineage, no CadDocument. All Prisma wiring lives in
 * `copy-design-operation-status-db.ts`; the `server-only` shim is
 * `copy-design-operation-status.ts`; the route is
 * `GET /api/desktop/copy-design/operations/:operationId/status`.
 *
 * P6D PRODUCTION RECOVERY: every COPY entry variant (PENDING / MATERIALIZED
 * / INVALID) now also carries `sourceFileVersionId` - the immutable
 * `CopyDesignOperationEntry.sourceFileVersionId` this entry's reservation
 * was originally made against. This is the ONE minimal, additive,
 * read-only extension a DURABLE resume (reconstructing a resume attempt
 * with no in-memory session state, e.g. after an Inventor restart) needs -
 * `CopyDesignOperationEntry` already stored it; it was simply never
 * exposed on this DTO before. No schema/migration change - the column
 * already existed.
 *
 * IDENTITY DISCIPLINE: `operationId` is a STABLE DATABASE ID, used VERBATIM -
 * never trimmed, cased, or otherwise normalized (mirrors
 * `desktop-latest-versions-core.ts`'s treatment of `cadDocumentId`). A blank /
 * whitespace-padded / over-length value is a MALFORMED REQUEST (400), never
 * silently repaired.
 */

export const COPY_DESIGN_OPERATION_STATUS_CONTRACT = "arch-plm.copy-design-operation-status.v1";

/** A cuid is ~25 chars; anything materially longer is a malformed request. */
export const MAX_OPERATION_ID_LENGTH = 200;

export class CopyDesignOperationStatusValidationError extends Error {
  readonly status = 400;
  readonly publicMessage: string;
  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "CopyDesignOperationStatusValidationError";
    this.publicMessage = publicMessage;
  }
}

/** True when a value has leading/trailing whitespace - an opaque id must not. */
function hasSurroundingWhitespace(value: string): boolean {
  return value.length > 0 && value.trim().length !== value.length;
}

/**
 * Validate the `:operationId` path parameter.
 *
 * @throws CopyDesignOperationStatusValidationError (400) for blank,
 *   whitespace-padded, or over-length input. The value is otherwise returned
 *   VERBATIM - never trimmed or normalized.
 */
export function parseOperationId(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim().length === 0) {
    throw new CopyDesignOperationStatusValidationError("operationId must not be blank.");
  }
  if (hasSurroundingWhitespace(raw)) {
    throw new CopyDesignOperationStatusValidationError("operationId must not have leading or trailing whitespace.");
  }
  if (raw.length > MAX_OPERATION_ID_LENGTH) {
    throw new CopyDesignOperationStatusValidationError("operationId is too long.");
  }
  return raw;
}

// ------------------------------------------------------------
// Response DTOs
// ------------------------------------------------------------

interface CopyDesignOperationStatusEntryBase {
  /** The entry's position in the ORIGINAL request's `entries` array -
   *  matches `CopyDesignOperationEntry.ordinal` exactly (see that model's own
   *  doc comment in prisma/schema.prisma). */
  ordinal: number;
  /** IMMUTABLE snapshot fields from `CopyDesignOperationEntry`, exactly as
   *  they were the moment this entry was decided - NEVER re-read from
   *  current (mutable) `CadDocument` state. */
  originalDocumentNumber: string;
  originalFileName: string;
  originalDocumentType: string;
  /** P6D ROUND 4, item D: the immutable snapshot's optional description -
   *  previously omitted from this DTO entirely. `null` when the original
   *  request entry carried no description (never coalesced to `""`, which
   *  would be a different, false claim about what was originally decided). */
  originalDescription: string | null;
  /** ALWAYS the resulting identity: the new CadDocument for COPY, the
   *  existing one for REUSE. */
  resultingCadDocumentId: string;
}

export interface CopyDesignOperationStatusPendingEntry extends CopyDesignOperationStatusEntryBase {
  action: "COPY";
  state: "PENDING";
  sourceCadDocumentId: string;
  /** P6D PRODUCTION RECOVERY: the EXACT source FileVersion this entry's
   *  reservation was originally made against - immutable, from
   *  `CopyDesignOperationEntry.sourceFileVersionId`. Needed by a DURABLE
   *  resume (reconstructing a resume attempt with no in-memory session
   *  state, e.g. after an Inventor restart) to (a) prove the local source
   *  workspace still binds the same version, and (b) exactly reproduce the
   *  original reservation request so an idempotent replay is recognized as
   *  the SAME request. Previously omitted from this DTO entirely. */
  sourceFileVersionId: string;
}

export interface CopyDesignOperationStatusMaterializedEntry extends CopyDesignOperationStatusEntryBase {
  action: "COPY";
  state: "MATERIALIZED";
  sourceCadDocumentId: string;
  sourceFileVersionId: string;
  fileVersionId: string;
  versionNumber: 1;
  /** Canonical lowercase-hex SHA-256, 64 chars - from the selected FileVersion
   *  row only, never client input. */
  sha256: string;
  /** Canonical non-negative safe integer byte size - from the selected
   *  FileVersion row only. */
  fileSize: number;
}

export interface CopyDesignOperationStatusInvalidEntry extends CopyDesignOperationStatusEntryBase {
  action: "COPY";
  state: "INVALID";
  sourceCadDocumentId: string;
  sourceFileVersionId: string;
}

export interface CopyDesignOperationStatusReusedEntry extends CopyDesignOperationStatusEntryBase {
  action: "REUSE";
  state: "REUSED";
}

export type CopyDesignOperationStatusEntryDto =
  | CopyDesignOperationStatusPendingEntry
  | CopyDesignOperationStatusMaterializedEntry
  | CopyDesignOperationStatusInvalidEntry
  | CopyDesignOperationStatusReusedEntry;

export interface CopyDesignOperationStatusDto {
  contract: typeof COPY_DESIGN_OPERATION_STATUS_CONTRACT;
  copyDesignOperationId: string;
  idempotencyKey: string;
  performedAt: string;
  entries: CopyDesignOperationStatusEntryDto[];
}
