/**
 * Arch PLM - P6E-A: Prisma-shaped wiring for the Copy Design VERIFICATION
 * SUPPORT lookup. Mirrors `copy-design-operation-status-db.ts`'s own split
 * exactly (deliberately does NOT import "server-only" and takes `db` as a
 * required parameter, no singleton default, so the plain Node test runner
 * can exercise it with an in-memory fake database).
 *
 * REUSE, NOT DUPLICATION: this module calls `loadCopyDesignOperationStatus`
 * (P6D, unmodified) to get the operation's identity, entries, and
 * materialized-destination facts, then adds exactly the two facts that
 * function does not carry: source FileVersion integrity, and the operation's
 * own COMPONENT topology. It never re-implements lineage proof, entry
 * classification, or the operation-status contract itself.
 *
 * TENANT SCOPING: identical discipline to operation-status - the operation
 * lookup (inside `loadCopyDesignOperationStatus`) is scoped to
 * `(organizationId, operationId)`; both new queries here are additionally
 * scoped to `organizationId` on every `WHERE` clause, so a cross-tenant id
 * anywhere in the operation's own data (which cannot happen given the
 * schema's composite FKs, but is never assumed here either) could not leak
 * another tenant's rows.
 *
 * READ-ONLY: only `.findMany()`, called via `loadCopyDesignOperationStatus`
 * plus two new `.findMany()`s here. No `.create()` / `.update()` / `.delete()`,
 * no storage access, no binary content ever read.
 *
 * P6E-A CONTRACT HARDENING: `sourceFileVersionIntegrity` now returns EXACTLY
 * ONE explicit evidence record per COPY entry (AVAILABLE / UNAVAILABLE /
 * INVALID - see `copy-design-verification-support-core.ts`'s own doc
 * comment), never a silently-omitted one. This closes the gap where a
 * consumer iterating a shorter, deduplicated array could mistake "this
 * entry's id never appeared" for "nothing to worry about".
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { isCanonicalSha256, toSafeFileSize } from "./desktop-latest-versions-core.ts";
import {
  loadCopyDesignOperationStatus,
  CopyDesignOperationStatusNotFoundError,
  type CopyDesignOperationStatusDb,
} from "./copy-design-operation-status-db.ts";
import {
  COPY_DESIGN_VERIFICATION_SUPPORT_CONTRACT,
  type CopyDesignVerificationComponentEdgeDto,
  type CopyDesignVerificationSourceIntegrityDto,
} from "./copy-design-verification-support-core.ts";

export { CopyDesignOperationStatusNotFoundError };

export interface CopyDesignVerificationSupportDto {
  contract: typeof COPY_DESIGN_VERIFICATION_SUPPORT_CONTRACT;
  copyDesignOperationId: string;
  /** The FULL, unmodified `arch-plm.copy-design-operation-status.v1` payload -
   *  reused verbatim, never re-derived. */
  operationStatus: Awaited<ReturnType<typeof loadCopyDesignOperationStatus>>;
  sourceFileVersionIntegrity: CopyDesignVerificationSourceIntegrityDto[];
  componentEdges: CopyDesignVerificationComponentEdgeDto[];
}

/** The slice of PrismaClient this module needs, beyond what
 *  `loadCopyDesignOperationStatus` already requires. */
export type CopyDesignVerificationSupportDb = CopyDesignOperationStatusDb & Pick<PrismaClient, "cadDependency">;

/**
 * Load the verification-support DTO for `operationId` in `organizationId`.
 *
 * @throws CopyDesignOperationStatusNotFoundError (404) if no such operation
 *   exists in this organization - the SAME error `loadCopyDesignOperationStatus`
 *   already throws, propagated unchanged so unknown-id and foreign-tenant-id
 *   remain indistinguishable exactly as P6D already established.
 */
export async function loadCopyDesignVerificationSupport(
  db: CopyDesignVerificationSupportDb,
  organizationId: string,
  operationId: string,
): Promise<CopyDesignVerificationSupportDto> {
  const operationStatus = await loadCopyDesignOperationStatus(db, organizationId, operationId);

  // ---- B. source FileVersion integrity -----------------------------------
  // P6E-A CONTRACT HARDENING: EVERY COPY entry gets EXACTLY ONE explicit
  // evidence record - AVAILABLE / UNAVAILABLE / INVALID - never a silent
  // omission. See CopyDesignVerificationSourceIntegrityDto's own doc comment
  // for the full state semantics. Evaluated regardless of the entry's own
  // materialization state (PENDING/MATERIALIZED/INVALID): source integrity
  // is a property of the SOURCE, independent of how the destination turned
  // out. REUSE entries never get a record at all - see the module-level
  // "REUSE" note further down.
  const sourceFileVersionIds = new Set<string>();
  for (const entry of operationStatus.entries) {
    if (entry.action === "COPY") {
      sourceFileVersionIds.add(entry.sourceFileVersionId);
    }
  }

  // Looked up by id ALONE (never by (id, claimed cadDocumentId) together) -
  // a row that exists but belongs to a DIFFERENT cadDocumentId than an
  // entry claims must still be FOUND here, so the mismatch itself can be
  // reported as INVALID rather than silently looking like UNAVAILABLE.
  const sourceFileVersionRows =
    sourceFileVersionIds.size === 0
      ? []
      : await db.fileVersion.findMany({
          where: { organizationId, id: { in: [...sourceFileVersionIds] } },
          select: { id: true, cadDocumentId: true, checksum: true, fileSize: true },
        });
  const rowById = new Map(sourceFileVersionRows.map((row) => [row.id, row]));

  const sourceFileVersionIntegrity: CopyDesignVerificationSourceIntegrityDto[] = [];
  for (const entry of operationStatus.entries) {
    if (entry.action !== "COPY") {
      continue;
    }
    const base = { ordinal: entry.ordinal, sourceCadDocumentId: entry.sourceCadDocumentId, sourceFileVersionId: entry.sourceFileVersionId };
    const row = rowById.get(entry.sourceFileVersionId);
    if (!row) {
      sourceFileVersionIntegrity.push({ ...base, state: "UNAVAILABLE" });
      continue;
    }
    if (row.cadDocumentId !== entry.sourceCadDocumentId) {
      sourceFileVersionIntegrity.push({
        ...base, state: "INVALID",
        reason: "the source FileVersion belongs to a different CadDocument than sourceCadDocumentId names",
      });
      continue;
    }
    if (!isCanonicalSha256(row.checksum)) {
      sourceFileVersionIntegrity.push({ ...base, state: "INVALID", reason: "non-canonical checksum" });
      continue;
    }
    const fileSize = toSafeFileSize(row.fileSize);
    if (fileSize === null) {
      sourceFileVersionIntegrity.push({ ...base, state: "INVALID", reason: "fileSize not representable" });
      continue;
    }
    sourceFileVersionIntegrity.push({ ...base, state: "AVAILABLE", sha256: row.checksum, fileSize });
  }

  // ---- C. source/topology COMPONENT edges --------------------------------
  // Scope: the operation's own TOPOLOGY IDENTITY SET - the UNION of every
  // COPY entry's sourceCadDocumentId and every REUSE entry's
  // resultingCadDocumentId (APPROVED - see
  // CopyDesignVerificationComponentEdgeDto's own doc comment for why a
  // REUSE'd document's identity must be included: it is still part of this
  // operation's own topology, not an "unrelated document outside it"). This
  // is NOT merely "every COPY entry's sourceCadDocumentId" - the name
  // `operationTopologyIdentitySet` below is deliberately not
  // `copySourceIds` to keep that distinction visible at the call site.
  const operationTopologyIdentitySet = new Set<string>();
  for (const entry of operationStatus.entries) {
    if (entry.action === "COPY") {
      operationTopologyIdentitySet.add(entry.sourceCadDocumentId);
    } else {
      operationTopologyIdentitySet.add(entry.resultingCadDocumentId);
    }
  }

  const componentEdgeRows =
    operationTopologyIdentitySet.size === 0
      ? []
      : await db.cadDependency.findMany({
          where: {
            organizationId,
            dependencyType: "COMPONENT",
            parentDocumentId: { in: [...operationTopologyIdentitySet] },
            childDocumentId: { in: [...operationTopologyIdentitySet] },
          },
          select: { parentDocumentId: true, childDocumentId: true },
          orderBy: [{ parentDocumentId: "asc" }, { childDocumentId: "asc" }],
        });

  // Deduplicate (the schema's own @@unique already forbids a literal
  // duplicate row, but this stays defensive/deterministic regardless of
  // query-plan row order).
  const seenEdges = new Set<string>();
  const componentEdges: CopyDesignVerificationComponentEdgeDto[] = [];
  for (const row of componentEdgeRows) {
    const key = `${row.parentDocumentId}\u0000${row.childDocumentId}`;
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    componentEdges.push({ parentCadDocumentId: row.parentDocumentId, childCadDocumentId: row.childDocumentId });
  }

  return {
    contract: COPY_DESIGN_VERIFICATION_SUPPORT_CONTRACT,
    copyDesignOperationId: operationStatus.copyDesignOperationId,
    operationStatus,
    sourceFileVersionIntegrity,
    componentEdges,
  };
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CopyDesignVerificationSupportHttpResult {
  status: number;
  body: unknown;
}

export async function copyDesignVerificationSupportHttpResult(
  actor: Actor | null,
  operationId: string,
  db: CopyDesignVerificationSupportDb,
): Promise<CopyDesignVerificationSupportHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }

  try {
    const dto = await loadCopyDesignVerificationSupport(db, actor.organizationId, operationId);
    return { status: 200, body: dto };
  } catch (error) {
    if (error instanceof CopyDesignOperationStatusNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    throw error;
  }
}
