/**
 * Arch PLM - Copy Design identity reservation + lineage: Prisma-shaped
 * wiring (P6B).
 *
 * Deliberately does NOT import "server-only" and takes `db` as a required
 * parameter (no singleton default), mirroring `checkout-db.ts` /
 * `upload-guard-db.ts` / `release-db.ts` exactly, so this module stays
 * loadable by the plain Node test runner with an in-memory fake database.
 * The server-only shim is `app/lib/copy-design-lineage.ts`; the route
 * surface is `POST /api/desktop/copy-design/apply`.
 *
 * TENANT SCOPING: every query is filtered by `organizationId =
 * actor.organizationId`, taken only from the verified `Actor` the caller
 * passes in - never from the request body. A cross-tenant source/reuse id is
 * reported with the SAME generic "not found" error as a truly nonexistent
 * one - never distinguished, never leaked.
 *
 * ATOMICITY: `applyCopyDesignOperationForActor` validates the COMPLETE
 * request first - every COPY source CadDocument + FileVersion pairing,
 * every REUSE target, and every destination documentNumber collision -
 * entirely inside ONE SERIALIZABLE transaction, and only writes the
 * CopyDesignOperation + every new CadDocument + every CadCopyLineage row
 * after ALL of that validation succeeds. Any failure at any point throws out
 * of the transaction callback, which rolls back EVERYTHING it did - there is
 * no code path that leaves a partial set of new identities behind.
 *
 * IDEMPOTENCY: `idempotencyKey` is unique per organization
 * (`@@unique([organizationId, idempotencyKey])`). A request naming a key
 * that already has a stored `CopyDesignOperation`:
 *   - with an EQUIVALENT canonical payload -> returns the ORIGINAL result,
 *     reconstructed from the stored `requestPayload` + the persisted
 *     `CadCopyLineage` rows, WITHOUT creating anything new;
 *   - with a DIFFERENT canonical payload -> rejected with
 *     `CopyDesignIdempotencyConflictError` (409) - never silently returns an
 *     unrelated result.
 * This is checked twice: a fast, non-authoritative pre-check before opening
 * a transaction at all, and an authoritative re-check INSIDE the locked
 * transaction (closing the race window between two concurrent requests
 * using the same brand-new key) - exactly the "pre-check, then authoritative
 * in-transaction re-check" shape `checkout-db.ts` already uses for its own
 * idempotent-acquisition path. A race that still slips through (two
 * concurrent inserts both missing each other's pre-check) is resolved by
 * catching the resulting unique-constraint violation and reconciling against
 * whichever request actually won.
 *
 * SCOPE: this module creates ONLY CadDocument + CopyDesignOperation +
 * CadCopyLineage rows. It never creates a FileVersion, never touches
 * ItemRevision/lifecycle, never touches CadDependency, and never performs
 * any Inventor / physical-file operation - see the module doc comment in
 * `copy-design-lineage-core.ts`.
 *
 * RESERVED IDENTITY STATE: a COPY's new CadDocument needs NO new state
 * column to mark it "reserved, not yet materialized" - see
 * `prisma/schema.prisma`'s CopyDesignOperation/CadCopyLineage doc comment
 * for the full reasoning. It is simply the conjunction of two independently
 * queryable facts: `copyLineageAsNew` exists AND `fileVersions` is empty.
 * P6C materializes it by creating that CadDocument's first FileVersion
 * through the EXISTING `storeCadFileVersionForActor` path - no new code is
 * needed here for that transition to become true automatically.
 */
import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { CadDocumentType, UserRole } from "../generated/prisma/enums.ts";
import {
  runSerializableTransaction,
  SerializableTransactionExhaustedError,
} from "./db-concurrency-db.ts";
import {
  canonicalCopyDesignPayload,
  copyDesignPayloadsEqual,
  COPY_DESIGN_APPLY_CONTRACT,
  CopyDesignValidationError,
  parseCopyDesignApplyRequest,
  type CopyDesignApplyRequest,
  type CopyDesignApplyResultDto,
  type CopyDesignCopyEntry,
  type CopyDesignResultEntry,
} from "./copy-design-lineage-core.ts";

export { CopyDesignValidationError };
export type { CopyDesignApplyResultDto };

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class CopyDesignRoleError extends Error {
  constructor() {
    super("Your role does not permit reserving Copy Design identities");
    this.name = "CopyDesignRoleError";
  }
}

/** Thrown for ANY missing/cross-tenant COPY source (document or FileVersion
 *  mismatch) or REUSE target. Deliberately generic and undifferentiated -
 *  never says which id, which entry, or why - so a cross-tenant identifier
 *  can never be distinguished from a genuinely nonexistent one. */
export class CopyDesignSourceNotFoundError extends Error {
  constructor() {
    super("A referenced CAD document or file version was not found in your organization");
    this.name = "CopyDesignSourceNotFoundError";
  }
}

/** One (documentNumber, documentType) PAIR that collided against an
 *  EXISTING document - P6D ROUND 2, HIGH fix: a collision is now scoped by
 *  type, matching `CadDocument`'s `@@unique([organizationId, documentNumber,
 *  documentType])` - the SAME documentNumber with a DIFFERENT documentType
 *  is never a collision. */
export interface CopyDesignConflictingDestination {
  documentNumber: string;
  documentType: string;
}

/** Thrown when one or more proposed destination (documentNumber,
 *  documentType) pairs already exist in the tenant. Carries only the
 *  CLIENT'S OWN proposed pairs - never anything about who else might hold
 *  them. No overwrite, no auto-rename: the caller must choose a different
 *  number or type and retry. */
export class CopyDesignDestinationConflictError extends Error {
  readonly conflictingDestinations: readonly CopyDesignConflictingDestination[];
  /** @deprecated Back-compat projection of `conflictingDestinations` -
   *  the bare documentNumber strings, deduplicated, with no type
   *  information. Prefer `conflictingDestinations`. */
  readonly conflictingDocumentNumbers: readonly string[];
  constructor(conflictingDestinations: readonly CopyDesignConflictingDestination[]) {
    super("One or more destination document numbers already exist in your organization");
    this.name = "CopyDesignDestinationConflictError";
    this.conflictingDestinations = conflictingDestinations;
    this.conflictingDocumentNumbers = [...new Set(conflictingDestinations.map((d) => d.documentNumber))];
  }
}

/** Thrown when `idempotencyKey` already names an operation whose request
 *  does NOT match the current one. Never silently returns the unrelated
 *  original result. */
export class CopyDesignIdempotencyConflictError extends Error {
  constructor() {
    super("This idempotency key was already used for a different Copy Design request");
    this.name = "CopyDesignIdempotencyConflictError";
  }
}

/** Thrown only after the bounded SERIALIZABLE retry is exhausted under
 *  genuine concurrent load. Never carries Prisma internals. */
export class CopyDesignConcurrencyConflictError extends Error {
  constructor() {
    super("Could not complete the Copy Design operation due to concurrent changes, please retry");
    this.name = "CopyDesignConcurrencyConflictError";
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * ROUND 3, LOW: the violated constraint's `meta.target`, still in EITHER
 * shape Prisma may report it - an array of column names (the normal case)
 * or a single constraint/index-name string (some drivers / raw SQL paths) -
 * but kept as a DISCRIMINATED shape rather than collapsed into one, since
 * Round 2's collapse (wrapping a string in a 1-element array) is exactly
 * what made loose substring/containment matching necessary. `null` means
 * `error` is not a unique-constraint violation, or its target could not be
 * read at all - callers must treat that identically to "unrecognized".
 */
type P2002Target = { kind: "fields"; fields: string[] } | { kind: "name"; name: string } | null;

function p2002Target(error: unknown): P2002Target {
  if (!isUniqueConstraintViolation(error)) {
    return null;
  }
  const meta = (error as { meta?: unknown }).meta;
  const target =
    meta && typeof meta === "object" && "target" in meta ? (meta as { target: unknown }).target : undefined;
  if (Array.isArray(target)) {
    return { kind: "fields", fields: target.filter((field): field is string => typeof field === "string") };
  }
  if (typeof target === "string") {
    return { kind: "name", name: target };
  }
  return null;
}

/**
 * ROUND 3, LOW: one of this module's three known unique constraints, by its
 * EXACT column set (array-shaped `meta.target`) and its EXACT PostgreSQL
 * index name (string-shaped `meta.target`) - the real name Prisma's `@@unique`
 * generates, taken directly from the migration that created it. Any other
 * constraint - known-looking but not an exact match, or genuinely unknown -
 * must never be misclassified as one of these.
 */
const KNOWN_UNIQUE_CONSTRAINTS = {
  /** CopyDesignOperation's `@@unique([organizationId, idempotencyKey])` -
   *  see 20260916191133_add_copy_design_operation_lineage/migration.sql. */
  idempotencyKey: {
    fields: ["organizationId", "idempotencyKey"],
    indexName: "CopyDesignOperation_organizationId_idempotencyKey_key",
  },
  /** CadDocument's `@@unique([organizationId, documentNumber, documentType])`
   *  - see 20260921183016_scope_document_number_uniqueness_by_type/migration.sql.
   *  P6D ROUND 2, HIGH fix: was `@@unique([organizationId, documentNumber])`
   *  (index `CadDocument_organizationId_documentNumber_key`) - scoped by
   *  documentType too, so a model/drawing pair sharing one engineering
   *  number no longer collides. */
  documentNumberAndType: {
    fields: ["organizationId", "documentNumber", "documentType"],
    indexName: "CadDocument_organizationId_documentNumber_documentType_key",
  },
  /** CopyDesignOperationEntry's `@@unique([organizationId,
   *  copyDesignOperationId, ordinal])` - PostgreSQL's 63-byte identifier
   *  limit truncates the generated name to exactly this (no trailing
   *  "Id_ordinal") - see
   *  20260916194738_add_copy_design_operation_entries/migration.sql. */
  operationEntryOrdinal: {
    fields: ["organizationId", "copyDesignOperationId", "ordinal"],
    indexName: "CopyDesignOperationEntry_organizationId_copyDesignOperation_key",
  },
} as const satisfies Record<string, { fields: readonly string[]; indexName: string }>;

/**
 * True iff `target` is EXACTLY the named known constraint - an EXACT column
 * SET match (same length, same members - not a subset/superset, not mere
 * containment) for the array shape, or an EXACT index-name match for the
 * string shape. A target naming an unrelated, unknown, or merely
 * superset/subset-overlapping constraint returns false - callers must then
 * treat the error as unrecognized, never guess.
 */
function matchesKnownUniqueConstraint(
  target: P2002Target,
  constraint: { readonly fields: readonly string[]; readonly indexName: string },
): boolean {
  if (target === null) {
    return false;
  }
  if (target.kind === "name") {
    return target.name === constraint.indexName;
  }
  if (target.fields.length !== constraint.fields.length) {
    return false;
  }
  const expected = new Set(constraint.fields);
  return target.fields.every((field) => expected.has(field));
}

/** Mirrors `authz.ts`'s `PLM_WRITE_ROLES` / `assertCanMutate` (the EXISTING
 *  normal engineering-mutation floor already used for managed CAD creation,
 *  e.g. `createCadDocument`) - duplicated, not imported, because authz.ts is
 *  server-only and this module must stay plain-Node-testable. Keep in sync
 *  if the role matrix there ever changes. */
function actorCanApplyCopyDesign(actor: Actor): boolean {
  return actor.role !== UserRole.VIEWER;
}

/** The slice of PrismaClient this module needs. Narrowed so tests can inject
 *  a lightweight in-memory fake with the same shape. */
export type CopyDesignDb = Pick<
  PrismaClient,
  | "cadDocument"
  | "fileVersion"
  | "copyDesignOperation"
  | "cadCopyLineage"
  | "copyDesignOperationEntry"
  | "$transaction"
>;

// ROUND 2, HIGH: `entries` (NOT `lineageEntries`) is the ONLY thing an
// idempotent replay reads to reconstruct its response - see
// `CopyDesignOperationEntry`'s doc comment in prisma/schema.prisma for why.
// Ordered by `ordinal` so the caller never has to re-sort.
const OPERATION_SELECT = {
  id: true,
  performedAt: true,
  requestPayload: true,
  entries: {
    orderBy: { ordinal: "asc" },
    select: {
      ordinal: true,
      action: true,
      sourceCadDocumentId: true,
      sourceFileVersionId: true,
      resultingCadDocumentId: true,
      originalDocumentNumber: true,
      originalFileName: true,
      originalDocumentType: true,
    },
  },
} as const;

type StoredOperation = {
  id: string;
  performedAt: Date;
  requestPayload: unknown;
  entries: Array<{
    ordinal: number;
    action: string;
    sourceCadDocumentId: string | null;
    sourceFileVersionId: string | null;
    resultingCadDocumentId: string;
    originalDocumentNumber: string;
    originalFileName: string;
    originalDocumentType: unknown;
  }>;
};

/**
 * Reconstruct the exact original response for an idempotent retry.
 *
 * ROUND 2, HIGH FIX: this is now SYNCHRONOUS and reads ONLY the immutable
 * `CopyDesignOperationEntry` snapshot rows (ordered by their stable
 * `ordinal`) - it never re-reads CURRENT CadDocument state (documentNumber,
 * fileName, description are all mutable and can change after this operation
 * ran, for EITHER a COPY result or a REUSE target) and never correlates
 * anything by documentNumber. `resultingCadDocumentId` + `ordinal` are the
 * only identities this function ever depends on, and neither can change once
 * written.
 *
 * @throws CopyDesignIdempotencyConflictError if the retry's canonical
 *   payload does not match the stored one.
 */
function reconcileExistingOperation(
  existing: StoredOperation,
  canonicalPayload: unknown,
): CopyDesignApplyResultDto {
  if (!copyDesignPayloadsEqual(existing.requestPayload, canonicalPayload)) {
    throw new CopyDesignIdempotencyConflictError();
  }

  const entries: CopyDesignResultEntry[] = existing.entries.map((stored) => {
    if (stored.action === "REUSE") {
      return {
        action: "REUSE",
        cadDocumentId: stored.resultingCadDocumentId,
        resultingCadDocumentId: stored.resultingCadDocumentId,
        documentNumber: stored.originalDocumentNumber,
        fileName: stored.originalFileName,
        documentType: String(stored.originalDocumentType),
      };
    }
    return {
      action: "COPY",
      // COPY entries always have both source ids - enforced at write time
      // (see applyWithinTransaction) and by the schema's nullable-composite
      // FK, which only ever leaves both null together for REUSE.
      sourceCadDocumentId: stored.sourceCadDocumentId as string,
      sourceFileVersionId: stored.sourceFileVersionId as string,
      resultingCadDocumentId: stored.resultingCadDocumentId,
      documentNumber: stored.originalDocumentNumber,
      fileName: stored.originalFileName,
      documentType: String(stored.originalDocumentType),
    };
  });

  return {
    contract: COPY_DESIGN_APPLY_CONTRACT,
    copyDesignOperationId: existing.id,
    performedAt: existing.performedAt.toISOString(),
    entries,
  };
}

type ResolvedEntry =
  | { kind: "copy"; entry: CopyDesignCopyEntry }
  | {
      kind: "reuse";
      cadDocumentId: string;
      existing: {
        id: string;
        documentNumber: string;
        fileName: string;
        documentType: unknown;
        description: string | null;
      };
    };

/**
 * Validate the COMPLETE request, then (only if every check passes) create
 * the CopyDesignOperation and every COPY identity/lineage row - all inside
 * the CALLER's already-open transaction. Any thrown error rolls back
 * everything this function did.
 */
async function applyWithinTransaction(
  tx: CopyDesignDb,
  actor: Actor,
  request: CopyDesignApplyRequest,
  canonicalPayload: unknown,
): Promise<CopyDesignApplyResultDto> {
  // Authoritative idempotency re-check - closes the race window between the
  // fast pre-check (outside any transaction) and this attempt.
  const insideExisting = await tx.copyDesignOperation.findFirst({
    where: { organizationId: actor.organizationId, idempotencyKey: request.idempotencyKey },
    select: OPERATION_SELECT,
  });
  if (insideExisting) {
    return reconcileExistingOperation(insideExisting, canonicalPayload);
  }

  // ---- VALIDATE THE ENTIRE REQUEST FIRST (read-only) ----------------
  const resolved: ResolvedEntry[] = [];
  for (const entry of request.entries) {
    if (entry.action === "COPY") {
      const sourceDoc = await tx.cadDocument.findFirst({
        where: { organizationId: actor.organizationId, id: entry.sourceCadDocumentId },
        select: { id: true },
      });
      if (!sourceDoc) {
        throw new CopyDesignSourceNotFoundError();
      }
      // Proves BOTH that the FileVersion exists in-tenant AND that it truly
      // belongs to this exact sourceCadDocumentId - one query, one
      // undifferentiated failure mode for either problem.
      const sourceVersion = await tx.fileVersion.findFirst({
        where: {
          organizationId: actor.organizationId,
          cadDocumentId: entry.sourceCadDocumentId,
          id: entry.sourceFileVersionId,
        },
        select: { id: true },
      });
      if (!sourceVersion) {
        throw new CopyDesignSourceNotFoundError();
      }
      resolved.push({ kind: "copy", entry });
    } else {
      const existingDoc = await tx.cadDocument.findFirst({
        where: { organizationId: actor.organizationId, id: entry.cadDocumentId },
        select: { id: true, documentNumber: true, fileName: true, documentType: true, description: true },
      });
      if (!existingDoc) {
        throw new CopyDesignSourceNotFoundError();
      }
      resolved.push({ kind: "reuse", cadDocumentId: entry.cadDocumentId, existing: existingDoc });
    }
  }

  // Destination collision against EXISTING documents, scoped by
  // (documentNumber, documentType) - P6D ROUND 2, HIGH fix: the SAME
  // documentNumber with a DIFFERENT documentType (e.g. "1001.ipt" and
  // "1001.idw") is explicitly NOT a collision, matching CadDocument's
  // `@@unique([organizationId, documentNumber, documentType])`. (Intra-
  // request collisions were already rejected by parseCopyDesignApplyRequest,
  // using the SAME (number, type) pairing.)
  const proposedPairs = [
    ...new Map(
      resolved
        .filter((item): item is Extract<ResolvedEntry, { kind: "copy" }> => item.kind === "copy")
        .map((item) => {
          const documentType = CadDocumentType[item.entry.documentType as keyof typeof CadDocumentType];
          return [`${item.entry.newDocumentNumber}\u0000${documentType}`, { documentNumber: item.entry.newDocumentNumber, documentType }] as const;
        }),
    ).values(),
  ];
  if (proposedPairs.length > 0) {
    const collisions = await tx.cadDocument.findMany({
      where: {
        organizationId: actor.organizationId,
        OR: proposedPairs.map((pair) => ({ documentNumber: pair.documentNumber, documentType: pair.documentType })),
      },
      select: { documentNumber: true, documentType: true },
    });
    if (collisions.length > 0) {
      throw new CopyDesignDestinationConflictError(
        collisions.map((row) => ({ documentNumber: row.documentNumber, documentType: String(row.documentType) })),
      );
    }
  }

  // ---- VALIDATION SUCCEEDED - ONLY NOW WRITE ------------------------
  const operation = await tx.copyDesignOperation.create({
    data: {
      organizationId: actor.organizationId,
      idempotencyKey: request.idempotencyKey,
      performedById: actor.userId,
      label: request.label,
      requestPayload: canonicalPayload as Prisma.InputJsonValue,
    },
    select: { id: true, performedAt: true },
  });

  const resultEntries: CopyDesignResultEntry[] = [];
  // ROUND 2, HIGH: `ordinal` is the entry's 0-based position in the
  // ORIGINAL request array - assigned ONCE here, never recomputed, and is
  // the sole correlation key an idempotent replay uses. It comes from
  // `resolved`'s own index, which preserves `request.entries`' order
  // exactly (both branches above push in a single forward pass).
  for (let ordinal = 0; ordinal < resolved.length; ordinal += 1) {
    const item = resolved[ordinal]!;

    if (item.kind === "reuse") {
      resultEntries.push({
        action: "REUSE",
        cadDocumentId: item.existing.id,
        resultingCadDocumentId: item.existing.id,
        documentNumber: item.existing.documentNumber,
        fileName: item.existing.fileName,
        documentType: String(item.existing.documentType),
      });
      // REUSE creates no CadCopyLineage (it has no "copied from"
      // relationship) but still gets a complete, immutable
      // CopyDesignOperationEntry snapshot - required for replay to cover
      // REUSE entries too.
      await tx.copyDesignOperationEntry.create({
        data: {
          organizationId: actor.organizationId,
          copyDesignOperationId: operation.id,
          ordinal,
          action: "REUSE",
          resultingCadDocumentId: item.existing.id,
          originalDocumentNumber: item.existing.documentNumber,
          originalFileName: item.existing.fileName,
          originalDocumentType: item.existing.documentType as CadDocumentType,
          originalDescription: item.existing.description,
        },
      });
      continue;
    }

    const documentType = CadDocumentType[item.entry.documentType as keyof typeof CadDocumentType];
    const newDoc = await tx.cadDocument.create({
      data: {
        organizationId: actor.organizationId,
        documentNumber: item.entry.newDocumentNumber,
        fileName: item.entry.newFileName,
        documentType,
        description: item.entry.description,
        // Set from the authenticated actor on the server, never the client.
        createdById: actor.userId,
      },
      select: { id: true, documentNumber: true, fileName: true, documentType: true },
    });

    // The composite FK on sourceFileVersion (organizationId,
    // sourceCadDocumentId, sourceFileVersionId) -> FileVersion(organizationId,
    // cadDocumentId, id) is the database's OWN proof that this FileVersion
    // truly belongs to this source CadDocument - the read-only check above
    // already established the same fact for a friendly error, but the FK is
    // the authoritative backstop.
    await tx.cadCopyLineage.create({
      data: {
        organizationId: actor.organizationId,
        copyDesignOperationId: operation.id,
        newCadDocumentId: newDoc.id,
        sourceCadDocumentId: item.entry.sourceCadDocumentId,
        sourceFileVersionId: item.entry.sourceFileVersionId,
        // Set from the authenticated actor on the server, never the client.
        copiedById: actor.userId,
      },
    });

    // The IMMUTABLE operation/replay snapshot - see this table's doc
    // comment in prisma/schema.prisma. Written in the SAME transaction as
    // the CadDocument + CadCopyLineage rows above, so it can never diverge
    // from what was actually created.
    await tx.copyDesignOperationEntry.create({
      data: {
        organizationId: actor.organizationId,
        copyDesignOperationId: operation.id,
        ordinal,
        action: "COPY",
        sourceCadDocumentId: item.entry.sourceCadDocumentId,
        sourceFileVersionId: item.entry.sourceFileVersionId,
        resultingCadDocumentId: newDoc.id,
        originalDocumentNumber: newDoc.documentNumber,
        originalFileName: newDoc.fileName,
        originalDocumentType: newDoc.documentType as CadDocumentType,
        originalDescription: item.entry.description,
      },
    });

    resultEntries.push({
      action: "COPY",
      sourceCadDocumentId: item.entry.sourceCadDocumentId,
      sourceFileVersionId: item.entry.sourceFileVersionId,
      resultingCadDocumentId: newDoc.id,
      documentNumber: newDoc.documentNumber,
      fileName: newDoc.fileName,
      documentType: String(newDoc.documentType),
    });
  }

  return {
    contract: COPY_DESIGN_APPLY_CONTRACT,
    copyDesignOperationId: operation.id,
    performedAt: operation.performedAt.toISOString(),
    entries: resultEntries,
  };
}

/**
 * Apply a confirmed Copy Design plan for `actor`: reserve a brand-new
 * CadDocument identity + immutable lineage row for every COPY entry, and
 * validate (without creating anything) every REUSE entry.
 *
 * Never creates a FileVersion, never touches ItemRevision/lifecycle, never
 * touches CadDependency, and performs NO Inventor / physical-file operation.
 *
 * @throws CopyDesignRoleError (403) if the actor's role cannot mutate.
 * @throws CopyDesignValidationError (400) for a malformed request.
 * @throws CopyDesignSourceNotFoundError (404) if any COPY source
 *   CadDocument/FileVersion pairing or REUSE target does not exist in the
 *   actor's organization.
 * @throws CopyDesignDestinationConflictError (409) if any proposed
 *   destination documentNumber already exists.
 * @throws CopyDesignIdempotencyConflictError (409) if idempotencyKey names
 *   an existing operation whose request does not match this one.
 * @throws CopyDesignConcurrencyConflictError (409) if the bounded
 *   SERIALIZABLE retry is exhausted under genuine concurrent load.
 */
export async function applyCopyDesignOperationForActor(
  actor: Actor,
  rawRequest: unknown,
  db: CopyDesignDb,
): Promise<CopyDesignApplyResultDto> {
  if (!actorCanApplyCopyDesign(actor)) {
    throw new CopyDesignRoleError();
  }

  const request = parseCopyDesignApplyRequest(rawRequest);
  const canonicalPayload = canonicalCopyDesignPayload(request);

  // Fast pre-check (non-authoritative): avoids a doomed transaction attempt
  // when the idempotency key is already known. The AUTHORITATIVE decision is
  // always the re-check inside applyWithinTransaction.
  const existing = await db.copyDesignOperation.findFirst({
    where: { organizationId: actor.organizationId, idempotencyKey: request.idempotencyKey },
    select: OPERATION_SELECT,
  });
  if (existing) {
    return reconcileExistingOperation(existing, canonicalPayload);
  }

  try {
    return await runSerializableTransaction(db, (tx) =>
      applyWithinTransaction(tx as unknown as CopyDesignDb, actor, request, canonicalPayload),
    );
  } catch (error) {
    if (error instanceof SerializableTransactionExhaustedError) {
      // ROUND 2, LOW 2: retries are exhausted, but that does NOT necessarily
      // mean nothing happened - another concurrent request using the SAME
      // idempotency key may have already committed successfully while ours
      // kept losing the serialization race. One final, authoritative lookup
      // before giving up: if a matching operation now exists, return ITS
      // result instead of a spurious conflict; a materially different
      // request under the same key still correctly conflicts (via
      // reconcileExistingOperation's own check).
      const afterExhaustion = await db.copyDesignOperation.findFirst({
        where: { organizationId: actor.organizationId, idempotencyKey: request.idempotencyKey },
        select: OPERATION_SELECT,
      });
      if (afterExhaustion) {
        return reconcileExistingOperation(afterExhaustion, canonicalPayload);
      }
      throw new CopyDesignConcurrencyConflictError();
    }
    if (
      error instanceof CopyDesignSourceNotFoundError ||
      error instanceof CopyDesignDestinationConflictError ||
      error instanceof CopyDesignIdempotencyConflictError
    ) {
      throw error;
    }

    // ROUND 2/3, LOW: inspect exactly WHICH unique constraint fired instead
    // of assuming any P2002 here means a destination documentNumber
    // collision - and require an EXACT match (exact column set, or exact
    // index name), never mere containment. An unrecognized (or non-P2002)
    // error is rethrown as-is - NEVER misreported as a document-number
    // collision.
    const target = p2002Target(error);
    if (target === null) {
      throw error;
    }
    if (matchesKnownUniqueConstraint(target, KNOWN_UNIQUE_CONSTRAINTS.idempotencyKey)) {
      // A concurrent request won the idempotency-key race. Reconcile
      // against whichever request actually committed - never mask the
      // original error type.
      const afterRace = await db.copyDesignOperation.findFirst({
        where: { organizationId: actor.organizationId, idempotencyKey: request.idempotencyKey },
        select: OPERATION_SELECT,
      });
      if (afterRace) {
        return reconcileExistingOperation(afterRace, canonicalPayload);
      }
      // The constraint that just fired proves a row exists for this key -
      // this is structurally unreachable, but fail closed rather than mask
      // it as anything else.
      throw new CopyDesignConcurrencyConflictError();
    }
    if (matchesKnownUniqueConstraint(target, KNOWN_UNIQUE_CONSTRAINTS.documentNumberAndType)) {
      // A concurrent, unrelated operation created a CadDocument with one of
      // our proposed destination (documentNumber, documentType) pairs first.
      throw new CopyDesignDestinationConflictError([]);
    }
    if (matchesKnownUniqueConstraint(target, KNOWN_UNIQUE_CONSTRAINTS.operationEntryOrdinal)) {
      // The operation-entry ordinal uniqueness constraint fired - never
      // expected in normal operation (ordinals are assigned once, 0-based,
      // inside this same transaction). Fail closed as a concurrency
      // conflict rather than misreport it as a destination collision.
      throw new CopyDesignConcurrencyConflictError();
    }
    // An unrecognized (or merely overlapping, non-exact) unique-constraint
    // violation - never guess which one it was; surface it as a generic
    // failure rather than misreport it.
    throw error;
  }
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CopyDesignApplyHttpResult {
  status: number;
  body: unknown;
}

/**
 * Map an authenticated (or unauthenticated) apply request to an HTTP status
 * + JSON body. Kept out of the route handler so it is unit-testable without
 * a running server.
 */
export async function copyDesignApplyHttpResult(
  actor: Actor | null,
  rawRequest: unknown,
  db: CopyDesignDb,
): Promise<CopyDesignApplyHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }

  try {
    const result = await applyCopyDesignOperationForActor(actor, rawRequest, db);
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof CopyDesignRoleError) {
      return { status: 403, body: { error: error.message } };
    }
    if (error instanceof CopyDesignValidationError) {
      return { status: error.status, body: { error: error.publicMessage } };
    }
    if (error instanceof CopyDesignSourceNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    if (error instanceof CopyDesignDestinationConflictError) {
      return {
        status: 409,
        body: {
          error: error.message,
          // Back-compat: bare numbers, deduplicated, no type information.
          conflictingDocumentNumbers: error.conflictingDocumentNumbers,
          // P6D ROUND 2: the precise (documentNumber, documentType) pairs
          // that actually collided.
          conflictingDestinations: error.conflictingDestinations,
        },
      };
    }
    if (error instanceof CopyDesignIdempotencyConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof CopyDesignConcurrencyConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}
