/**
 * Arch PLM - P6E-A: the authoritative, dedicated, READ-ONLY Copy Design
 * VERIFICATION SUPPORT lookup (provider-agnostic core).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only request-shape
 * validation and response DTO types, exactly mirroring
 * `copy-design-operation-status-core.ts`'s own split.
 *
 * WHY THIS EXISTS: P6E needs to independently, read-only-ly re-verify a
 * completed (or partially completed) Copy Design operation - that every COPY
 * entry's destination genuinely matches its server-recorded materialized
 * FileVersion, that the copied/reused package's reference topology matches
 * what the SOURCE package's topology says it should be, and that no source
 * file has been mutated since it was copied from. `copy-design-operation-
 * status-core.ts` (P6D) already answers "what happened to each entry" but
 * deliberately carries none of the SOURCE-side integrity or topology facts a
 * later, independent verification pass needs - this is a SEPARATE, additive
 * endpoint/contract for exactly those two missing facts, layered ON TOP OF
 * (never duplicating) the existing operation-status lookup.
 *
 * SCOPE: strictly READ-ONLY, exactly like operation-status. Never creates,
 * updates, or deletes anything. No verification DECISION (VERIFIED / FAILED
 * / INCOMPLETE) is made here at all - that is P6E-B's job, entirely offline
 * from this server response. This endpoint only surfaces durable FACTS.
 *
 * IDENTITY DISCIPLINE: `operationId` is a STABLE DATABASE ID, used VERBATIM -
 * reuses `copy-design-operation-status-core.ts`'s own `parseOperationId` (not
 * duplicated here) for identical validation.
 */

export const COPY_DESIGN_VERIFICATION_SUPPORT_CONTRACT = "arch-plm.copy-design-verification-support.v1";

// ------------------------------------------------------------
// Response DTOs
// ------------------------------------------------------------

/**
 * P6E-A CONTRACT HARDENING: EVERY COPY entry gets EXACTLY ONE explicit
 * source-integrity evidence record - never a silent omission. Missing or
 * malformed evidence is reported AS AN EXPLICIT STATE
 * (`UNAVAILABLE`/`INVALID`), not by the entry's absence from an array, so a
 * consumer iterating `operationStatus.entries` can never accidentally treat
 * "no record was returned" as "nothing to worry about" - there is always a
 * record to look at, for every COPY entry, full stop.
 *
 *   AVAILABLE   - the authoritative source FileVersion row was found, is
 *                 proven to belong to the claimed `sourceCadDocumentId` (and
 *                 this tenant), and carries a canonical SHA-256 + a
 *                 representable file size - both included, verbatim from
 *                 that row, NEVER fabricated or inferred.
 *   UNAVAILABLE - no FileVersion row matching `sourceFileVersionId` could be
 *                 found in this tenant at all - nothing to prove anything
 *                 with, closed rather than guessed at.
 *   INVALID     - a FileVersion row WAS found, but something about it makes
 *                 it untrustworthy as evidence for THIS entry: its
 *                 `checksum`/`fileSize` are missing or non-canonical, OR it
 *                 belongs to a DIFFERENT `cadDocumentId` than this entry's
 *                 own `sourceCadDocumentId` claims (a mismatched-ownership
 *                 row is not "missing evidence" - it is evidence that
 *                 something is WRONG, a materially different fact worth
 *                 keeping distinct from UNAVAILABLE).
 *
 * `ordinal`/`sourceCadDocumentId`/`sourceFileVersionId` are present on every
 * state so a consumer can correlate back to `operationStatus.entries`
 * without depending on array order or position.
 */
export type CopyDesignVerificationSourceIntegrityState = "AVAILABLE" | "UNAVAILABLE" | "INVALID";

interface CopyDesignVerificationSourceIntegrityBase {
  /** Matches the owning entry's `CopyDesignOperationEntry.ordinal` /
   *  `operationStatus.entries[].ordinal` exactly. */
  ordinal: number;
  sourceCadDocumentId: string;
  sourceFileVersionId: string;
}

export interface CopyDesignVerificationSourceIntegrityAvailable extends CopyDesignVerificationSourceIntegrityBase {
  state: "AVAILABLE";
  /** Canonical lowercase-hex SHA-256, exactly 64 characters - from the
   *  proven-owned FileVersion row only, never client input. */
  sha256: string;
  /** Canonical non-negative safe integer byte size - from the same row. */
  fileSize: number;
}

export interface CopyDesignVerificationSourceIntegrityUnavailable extends CopyDesignVerificationSourceIntegrityBase {
  state: "UNAVAILABLE";
}

export interface CopyDesignVerificationSourceIntegrityInvalid extends CopyDesignVerificationSourceIntegrityBase {
  state: "INVALID";
  /** Human-readable, e.g. "non-canonical checksum", "fileSize not
   *  representable", or "belongs to a different CadDocument than
   *  sourceCadDocumentId names" - never blank. */
  reason: string;
}

export type CopyDesignVerificationSourceIntegrityDto =
  | CopyDesignVerificationSourceIntegrityAvailable
  | CopyDesignVerificationSourceIntegrityUnavailable
  | CopyDesignVerificationSourceIntegrityInvalid;

/**
 * ONE authoritative `CadDependency` COMPONENT edge among this operation's own
 * TOPOLOGY IDENTITY SET - `parentCadDocumentId` --COMPONENT--> `childCadDocumentId`
 * (assembly -> its direct component/subassembly), exactly mirroring
 * `CadDependency`'s own parent/child direction. Only stable CadDocument ids -
 * never a dependency row's own internal id, never a display name.
 *
 * TOPOLOGY IDENTITY SET (APPROVED, see `copy-design-verification-support-db.ts`'s
 * own doc comment for the full reasoning) - NOT merely "every COPY entry's
 * sourceCadDocumentId": it is the UNION of
 *   - every COPY entry's `sourceCadDocumentId`, and
 *   - every REUSE entry's `resultingCadDocumentId`
 * i.e. every "original-identity" document this operation is about, COPY or
 * REUSE alike. A REUSE'd document is still part of the operation's own
 * topology (its children, if any, are exactly as real as a COPY source's),
 * so excluding it would silently produce an incomplete expected topology for
 * P6E-B. An edge to or from any document OUTSIDE that set (an unrelated
 * document elsewhere in the tenant) is never returned.
 */
export interface CopyDesignVerificationComponentEdgeDto {
  parentCadDocumentId: string;
  childCadDocumentId: string;
}
