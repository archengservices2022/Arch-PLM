/**
 * Arch PLM - Copy Design identity reservation + lineage: request shape,
 * canonicalization, and DTOs (P6B, provider-agnostic).
 *
 * P6D FINAL BLOCKER FIX: `newFileName` is validated with the shared
 * `isSafeCadBaseName` (`cad-basename-core.ts`) - see that module's doc
 * comment. This is the ONLY place `newFileName` is ever written into a
 * persisted `CopyDesignOperationEntry` row (`copy-design-lineage-db.ts`),
 * and the durable-resume operation-status endpoint later echoes that same
 * stored value back verbatim as `originalFileName` - so hardening it HERE,
 * before anything is ever persisted, protects every later reader (this
 * server's own status endpoint included, and the desktop client, which
 * independently re-validates on its own side too - see that module's doc
 * comment for why a client can never simply trust an already-validated
 * server).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds:
 *   - the request/response DTO shapes this milestone's API exposes;
 *   - the request-shape validation ("is this a well-formed apply request")
 *     the P6A CAD Connect client's confirmed Copy Design plan must satisfy;
 *   - the canonicalization used to compare a RETRIED request (same
 *     idempotencyKey) against the ORIGINAL one it is retrying, so a
 *     materially different request is rejected instead of silently
 *     returning an unrelated result.
 *
 * All Prisma wiring, tenant scoping, and the actual COPY/REUSE transaction
 * live in `app/lib/copy-design-lineage-db.ts`.
 *
 * SCOPE (P6B): this milestone reserves stable server-side identities and
 * records immutable lineage. It creates NO binary data, NO FileVersion, and
 * performs NO Inventor mutation of any kind (no physical file copy, no
 * SaveAs, no ReplaceReference, no drawing copy, no Mirror, no Pack & Go, no
 * PDF/DXF/STEP export). Those remain P6C and later.
 *
 * IDENTITY DISCIPLINE: `sourceCadDocumentId` / `sourceFileVersionId` /
 * `cadDocumentId` are STABLE DATABASE IDS - the ONLY identity this module
 * ever trusts. `newDocumentNumber` / `newFileName` / `documentType` /
 * `description` are DESTINATION METADATA the caller supplies for the NEW
 * CadDocument row - never used as identity, never used to look anything up.
 */
import { isSafeCadBaseName } from "./cad-basename-core.ts";

export const COPY_DESIGN_APPLY_CONTRACT = "arch-plm.copy-design-apply.v1";

/** Hard caps - a Copy Design plan is a bounded, human-reviewed set of
 *  documents, not an unbounded batch. Guards against a malformed or
 *  adversarial request forcing unbounded work. */
export const MAX_ENTRIES_PER_OPERATION = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_LABEL_LENGTH = 200;
export const MAX_FIELD_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

/** A 200-entry plan of short id/string fields is at most a few tens of KB;
 *  anything past this is rejected before it is even JSON-parsed. */
export const MAX_COPY_DESIGN_APPLY_BODY_BYTES = 256 * 1024;

/** Mirrors `prisma/schema.prisma`'s `CadDocumentType` enum values as plain
 *  strings. Duplicated (not imported) - this module must stay Prisma-free
 *  and framework-free, exactly like `checkout-core.ts` duplicates
 *  `authz.ts`'s role list rather than importing the server-only module. Keep
 *  in sync if the schema enum ever changes. */
export const CAD_DOCUMENT_TYPES = ["IPT", "IAM", "IDW", "DWG", "PDF", "OTHER"] as const;
export type CadDocumentTypeValue = (typeof CAD_DOCUMENT_TYPES)[number];

/**
 * ROUND 2, LOW 3: strict `Content-Type` acceptance - parses only the media
 * type (the part before the first `;`, so `application/json; charset=utf-8`
 * is still accepted), trims surrounding whitespace, and requires exact
 * case-insensitive equality with `application/json`. A loose substring check
 * (e.g. `.includes("application/json")`) would wrongly accept something like
 * `text/application/jsonx`.
 */
export function isStrictJsonContentType(headerValue: string | null | undefined): boolean {
  if (typeof headerValue !== "string") {
    return false;
  }
  const mediaType = headerValue.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

export class CopyDesignValidationError extends Error {
  readonly status = 400;
  readonly publicMessage: string;
  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "CopyDesignValidationError";
    this.publicMessage = publicMessage;
  }
}

// ------------------------------------------------------------
// Request shape
// ------------------------------------------------------------

export interface CopyDesignCopyEntry {
  action: "COPY";
  /** Stable id of the EXISTING CadDocument this copy is based on. */
  sourceCadDocumentId: string;
  /** Stable id of the EXACT source FileVersion this copy is based on - the
   *  server proves it truly belongs to sourceCadDocumentId before trusting
   *  it (see copy-design-lineage-db.ts). Never "whatever is latest". */
  sourceFileVersionId: string;
  /** Destination metadata for the NEW CadDocument row. Never identity. */
  newDocumentNumber: string;
  newFileName: string;
  documentType: CadDocumentTypeValue;
  description: string | null;
}

export interface CopyDesignReuseEntry {
  action: "REUSE";
  /** Stable id of the EXISTING CadDocument identity to keep as-is. */
  cadDocumentId: string;
}

export type CopyDesignEntry = CopyDesignCopyEntry | CopyDesignReuseEntry;

export interface CopyDesignApplyRequest {
  /** Client-generated OPAQUE token. Never derived from a filename, path,
   *  rename token, or document number - see the module doc comment. */
  idempotencyKey: string;
  /** Optional, display-only. Never part of the operation's meaning. */
  label: string | null;
  entries: CopyDesignEntry[];
}

// ------------------------------------------------------------
// Request parsing / validation
// ------------------------------------------------------------

function requiredNonBlankString(value: unknown, field: string, maxLength = MAX_FIELD_LENGTH): string {
  if (typeof value !== "string") {
    throw new CopyDesignValidationError(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CopyDesignValidationError(`${field} must not be blank.`);
  }
  if (trimmed.length > maxLength) {
    throw new CopyDesignValidationError(`${field} is too long.`);
  }
  return trimmed;
}

function parseIdempotencyKey(value: unknown): string {
  return requiredNonBlankString(value, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
}

function parseOptionalLabel(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CopyDesignValidationError("label must be a string when present.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new CopyDesignValidationError("label is too long.");
  }
  return trimmed;
}

function parseDocumentType(value: unknown, index: number): CadDocumentTypeValue {
  if (typeof value !== "string" || !(CAD_DOCUMENT_TYPES as readonly string[]).includes(value)) {
    throw new CopyDesignValidationError(
      `entries[${index}].documentType must be one of ${CAD_DOCUMENT_TYPES.join(", ")}.`,
    );
  }
  return value as CadDocumentTypeValue;
}

/**
 * P6D FINAL BLOCKER FIX: `newFileName` must be exactly ONE safe file name
 * component - see `isSafeCadBaseName`'s own doc comment for the exact
 * blocklist. Validated INDEPENDENTLY of `newDocumentNumber` (a plain
 * business-key string with its own `requiredNonBlankString` check, never
 * itself used to build a filesystem path here) - a caller cannot satisfy
 * this by making the two fields agree; each is checked on its own terms.
 * Fails closed with the SAME `CopyDesignValidationError` (400) every other
 * malformed-entry case already uses - never silently sanitized/rewritten.
 *
 * Deliberately does NOT trim before checking (unlike `requiredNonBlankString`,
 * used for every other field): trimming FIRST would silently turn a
 * trailing-space attack ("evil ") into an accepted, sanitized "evil" -
 * exactly the "do not silently sanitize" the task forbids. The raw value is
 * checked as-is, and the raw (untouched) value is what gets stored.
 */
function parseSafeNewFileName(value: unknown, index: number): string {
  if (typeof value !== "string") {
    throw new CopyDesignValidationError(`entries[${index}].newFileName is required.`);
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new CopyDesignValidationError(`entries[${index}].newFileName is too long.`);
  }
  const result = isSafeCadBaseName(value);
  if (!result.safe) {
    throw new CopyDesignValidationError(
      `entries[${index}].newFileName is not a safe file name (${result.reason}).`,
    );
  }
  return value;
}

function parseOptionalDescription(value: unknown, index: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CopyDesignValidationError(`entries[${index}].description must be a string when present.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // ROUND 2, MEDIUM: REJECT an overlong description - never truncate. Two
  // materially different descriptions that happen to share their first
  // MAX_DESCRIPTION_LENGTH characters must never canonicalize to the SAME
  // idempotency payload, which silent truncation would allow.
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new CopyDesignValidationError(
      `entries[${index}].description must not exceed ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function parseEntry(raw: unknown, index: number): CopyDesignEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new CopyDesignValidationError(`entries[${index}] must be an object.`);
  }
  const entry = raw as Record<string, unknown>;

  if (entry.action === "COPY") {
    return {
      action: "COPY",
      sourceCadDocumentId: requiredNonBlankString(
        entry.sourceCadDocumentId,
        `entries[${index}].sourceCadDocumentId`,
      ),
      sourceFileVersionId: requiredNonBlankString(
        entry.sourceFileVersionId,
        `entries[${index}].sourceFileVersionId`,
      ),
      newDocumentNumber: requiredNonBlankString(entry.newDocumentNumber, `entries[${index}].newDocumentNumber`),
      newFileName: parseSafeNewFileName(entry.newFileName, index),
      documentType: parseDocumentType(entry.documentType, index),
      description: parseOptionalDescription(entry.description, index),
    };
  }

  if (entry.action === "REUSE") {
    return {
      action: "REUSE",
      cadDocumentId: requiredNonBlankString(entry.cadDocumentId, `entries[${index}].cadDocumentId`),
    };
  }

  throw new CopyDesignValidationError(`entries[${index}].action must be "COPY" or "REUSE".`);
}

/**
 * Parse and validate a raw request body into a well-formed
 * `CopyDesignApplyRequest`.
 *
 * @throws CopyDesignValidationError (400) for any shape problem: missing
 *   idempotencyKey, empty/oversized entries array, an entry with an unknown
 *   action or missing required fields, an invalid documentType, or two COPY
 *   entries within the SAME request proposing the same (newDocumentNumber,
 *   documentType) PAIR (an intra-request destination collision - the DB-
 *   level collision check against EXISTING documents happens separately in
 *   the db module). P6D ROUND 2, HIGH fix: this is scoped by documentType,
 *   matching `CadDocument`'s `@@unique([organizationId, documentNumber,
 *   documentType])` - two COPY entries proposing the SAME documentNumber
 *   but DIFFERENT documentTypes (e.g. "1001.ipt" and "1001.idw" - the normal
 *   Inventor model/drawing pair) are explicitly ALLOWED, never rejected as a
 *   collision; only the SAME (documentNumber, documentType) pair twice is a
 *   real collision.
 */
export function parseCopyDesignApplyRequest(body: unknown): CopyDesignApplyRequest {
  if (typeof body !== "object" || body === null) {
    throw new CopyDesignValidationError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  const idempotencyKey = parseIdempotencyKey(raw.idempotencyKey);
  const label = parseOptionalLabel(raw.label);

  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new CopyDesignValidationError("entries must be a non-empty array.");
  }
  if (raw.entries.length > MAX_ENTRIES_PER_OPERATION) {
    throw new CopyDesignValidationError(`entries must not exceed ${MAX_ENTRIES_PER_OPERATION} items.`);
  }

  const entries = raw.entries.map((entry, index) => parseEntry(entry, index));

  const seenDestinations = new Set<string>();
  for (const entry of entries) {
    if (entry.action !== "COPY") {
      continue;
    }
    // NUL-separated compound key: documentType values never contain NUL, so
    // this can never collide two DIFFERENT (number, type) pairs onto the
    // same key the way plain string concatenation could.
    const key = `${entry.newDocumentNumber}\u0000${entry.documentType}`;
    if (seenDestinations.has(key)) {
      throw new CopyDesignValidationError(
        `Duplicate destination documentNumber "${entry.newDocumentNumber}" for documentType `
          + `"${entry.documentType}" within one request.`,
      );
    }
    seenDestinations.add(key);
  }

  return { idempotencyKey, label, entries };
}

// ------------------------------------------------------------
// Canonicalization for idempotent-retry comparison
// ------------------------------------------------------------

/**
 * The canonical, comparable shape of a request's MEANING - deliberately
 * excludes `idempotencyKey` itself (that is the lookup key, not part of what
 * is being compared) and `label` (display-only, never part of the
 * operation's meaning). Two requests with the same canonical payload are the
 * "same operation" for idempotency purposes; anything else is "materially
 * different".
 */
export function canonicalCopyDesignPayload(request: CopyDesignApplyRequest): unknown {
  return {
    entries: request.entries.map((entry) =>
      entry.action === "COPY"
        ? {
            action: "COPY" as const,
            sourceCadDocumentId: entry.sourceCadDocumentId,
            sourceFileVersionId: entry.sourceFileVersionId,
            newDocumentNumber: entry.newDocumentNumber,
            newFileName: entry.newFileName,
            documentType: entry.documentType,
            description: entry.description,
          }
        : { action: "REUSE" as const, cadDocumentId: entry.cadDocumentId },
    ),
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic (object-key-order-independent, array-order-SENSITIVE) JSON
 *  form used to compare two canonical payloads. Array order is deliberately
 *  significant: reordering the SAME entries is still treated as a different
 *  request (the simplest, safest definition of "materially different"). */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function copyDesignPayloadsEqual(a: unknown, b: unknown): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}

// ------------------------------------------------------------
// Response DTOs
// ------------------------------------------------------------

export interface CopyDesignCopyResultEntry {
  action: "COPY";
  sourceCadDocumentId: string;
  sourceFileVersionId: string;
  /** The newly reserved identity. NEVER equal to sourceCadDocumentId. */
  resultingCadDocumentId: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
}

export interface CopyDesignReuseResultEntry {
  action: "REUSE";
  cadDocumentId: string;
  /** Same value as cadDocumentId - present so every result entry exposes a
   *  uniform `resultingCadDocumentId` regardless of action. */
  resultingCadDocumentId: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
}

export type CopyDesignResultEntry = CopyDesignCopyResultEntry | CopyDesignReuseResultEntry;

export interface CopyDesignApplyResultDto {
  contract: typeof COPY_DESIGN_APPLY_CONTRACT;
  copyDesignOperationId: string;
  performedAt: string;
  entries: CopyDesignResultEntry[];
}
