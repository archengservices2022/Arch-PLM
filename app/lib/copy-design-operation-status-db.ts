/**
 * Arch PLM - P6D ROUND 3, HIGH fix (item D): Prisma-shaped wiring for the
 * authoritative, READ-ONLY Copy Design operation status lookup.
 *
 * Deliberately does NOT import "server-only" and takes `db` as a required
 * parameter (no singleton default), mirroring `copy-design-materialize-db.ts`
 * / `desktop-latest-versions-db.ts`, so this module stays loadable by the
 * plain Node test runner with an in-memory fake database. The server-only
 * shim is `app/lib/copy-design-operation-status.ts`; the route surface is
 * `GET /api/desktop/copy-design/operations/:operationId/status`.
 *
 * TENANT SCOPING: the operation is looked up by `(organizationId,
 * operationId)` - an operation belonging to a different organization (or no
 * operation at all) is INDISTINGUISHABLE, both surfacing as
 * `CopyDesignOperationStatusNotFoundError` (404). Never leaks whether the id
 * exists in a different tenant.
 *
 * PER-ENTRY STATE (P6D ROUND 3 item D's own enum contract - see
 * `copy-design-operation-status-core.ts`'s doc comment for why this replaces
 * the `latest-versions`-based inference):
 *
 *   REUSE entry  -> always REUSED. No FileVersion / lineage check - a REUSE
 *                   entry's only claim is "this existing CadDocument is the
 *                   resulting identity", which the immutable
 *                   CopyDesignOperationEntry snapshot itself already proves;
 *                   there is nothing further to materialize or verify.
 *
 *   COPY entry   -> first, a matching `CadCopyLineage` row MUST exist for
 *                   THIS EXACT (copyDesignOperationId, sourceCadDocumentId,
 *                   resultingCadDocumentId) triple - proving the resulting
 *                   identity genuinely IS this operation's copy of this
 *                   exact source, not merely "some CadDocument id the
 *                   caller is asking about". Missing/mismatched lineage is
 *                   ALWAYS INVALID, never silently treated as PENDING.
 *
 *                   Then the resulting CadDocument's COMPLETE FileVersion set
 *                   is loaded and classified:
 *                     - zero rows                              -> PENDING
 *                     - exactly one row, versionNumber === 1,
 *                       AND canonical sha256 + canonical fileSize
 *                                                                -> MATERIALIZED
 *                     - anything else (>1 row, wrong version
 *                       number, or non-canonical integrity on
 *                       the lone v1 row)                        -> INVALID
 *
 * This exactly mirrors P6C's own `classifyFileVersionState` three-way split
 * (Empty / ReplayCandidate / Malformed) in `copy-design-materialize-db.ts`,
 * generalized to a read-only report instead of a mutating decision, and
 * reuses `desktop-latest-versions-core.ts`'s `isCanonicalSha256` /
 * `toSafeFileSize` for the exact same "fail closed on non-canonical
 * integrity metadata" discipline `latest-versions` already applies.
 *
 * NEVER COLLAPSED: an unknown/foreign-tenant operation id (404), a role/auth
 * failure (401/403 - handled by the caller before this module is reached),
 * a malformed/INVALID entry state, a genuinely PENDING zero-version
 * reservation, and a communication/protocol failure on the CALLER's side of
 * this endpoint are five categorically different things and this module
 * never blurs any of them into another.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { isCanonicalSha256, toSafeFileSize } from "./desktop-latest-versions-core.ts";
import {
  COPY_DESIGN_OPERATION_STATUS_CONTRACT,
  type CopyDesignOperationStatusDto,
  type CopyDesignOperationStatusEntryDto,
} from "./copy-design-operation-status-core.ts";

/** Thrown when no operation exists in the actor's organization with this
 *  exact id - deliberately the SAME outcome for "genuinely does not exist"
 *  and "exists, but in a different organization". */
export class CopyDesignOperationStatusNotFoundError extends Error {
  constructor() {
    super("No Copy Design operation with this id exists in your organization");
    this.name = "CopyDesignOperationStatusNotFoundError";
  }
}

/** The slice of PrismaClient this module needs. Narrowed so tests can inject
 *  a lightweight in-memory fake with the same shape. */
export type CopyDesignOperationStatusDb = Pick<PrismaClient, "copyDesignOperation" | "cadCopyLineage" | "fileVersion">;

const OPERATION_SELECT = {
  id: true,
  idempotencyKey: true,
  performedAt: true,
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
      originalDescription: true,
    },
  },
} as const;

type StoredOperation = {
  id: string;
  idempotencyKey: string;
  performedAt: Date;
  entries: Array<{
    ordinal: number;
    action: "COPY" | "REUSE";
    sourceCadDocumentId: string | null;
    sourceFileVersionId: string | null;
    resultingCadDocumentId: string;
    originalDocumentNumber: string;
    originalFileName: string;
    originalDocumentType: string;
    originalDescription: string | null;
  }>;
};

interface FileVersionRow {
  id: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: bigint | null;
}

/**
 * Load the operation status DTO for `operationId` in `organizationId`.
 *
 * @throws CopyDesignOperationStatusNotFoundError (404) if no such operation
 *   exists in this organization.
 */
export async function loadCopyDesignOperationStatus(
  db: CopyDesignOperationStatusDb,
  organizationId: string,
  operationId: string,
): Promise<CopyDesignOperationStatusDto> {
  const operation = (await db.copyDesignOperation.findFirst({
    where: { organizationId, id: operationId },
    select: OPERATION_SELECT,
  })) as StoredOperation | null;
  if (!operation) {
    throw new CopyDesignOperationStatusNotFoundError();
  }

  const copyEntries = operation.entries.filter((e) => e.action === "COPY");
  const resultingIds = copyEntries.map((e) => e.resultingCadDocumentId);

  // Batched, not per-entry: one query for lineage proof, one for FileVersion
  // state, regardless of how many COPY entries this operation has.
  const lineageRows =
    resultingIds.length === 0
      ? []
      : await db.cadCopyLineage.findMany({
          where: { organizationId, copyDesignOperationId: operation.id, newCadDocumentId: { in: resultingIds } },
          select: { newCadDocumentId: true, sourceCadDocumentId: true },
        });
  const lineageBySourceThenTarget = new Map<string, string>(); // resultingCadDocumentId -> sourceCadDocumentId
  for (const row of lineageRows) {
    lineageBySourceThenTarget.set(row.newCadDocumentId, row.sourceCadDocumentId);
  }

  const fileVersionRows =
    resultingIds.length === 0
      ? []
      : ((await db.fileVersion.findMany({
          where: { organizationId, cadDocumentId: { in: resultingIds } },
          select: { id: true, cadDocumentId: true, versionNumber: true, checksum: true, fileSize: true },
        })) as Array<FileVersionRow & { cadDocumentId: string }>);
  const versionsByCadDocumentId = new Map<string, FileVersionRow[]>();
  for (const row of fileVersionRows) {
    const list = versionsByCadDocumentId.get(row.cadDocumentId);
    if (list) {
      list.push(row);
    } else {
      versionsByCadDocumentId.set(row.cadDocumentId, [row]);
    }
  }

  const entries: CopyDesignOperationStatusEntryDto[] = operation.entries.map((entry) => {
    const base = {
      ordinal: entry.ordinal,
      resultingCadDocumentId: entry.resultingCadDocumentId,
      originalDocumentNumber: entry.originalDocumentNumber,
      originalFileName: entry.originalFileName,
      originalDocumentType: entry.originalDocumentType,
      originalDescription: entry.originalDescription,
    };

    if (entry.action === "REUSE") {
      return { ...base, action: "REUSE", state: "REUSED" };
    }

    // COPY. `entry.sourceCadDocumentId` / `entry.sourceFileVersionId` are
    // guaranteed non-null TOGETHER for a COPY row by the DB CHECK constraint
    // described in prisma/schema.prisma - but never trusted blindly here
    // either.
    const sourceCadDocumentId = entry.sourceCadDocumentId;
    const sourceFileVersionId = entry.sourceFileVersionId;
    if (!sourceCadDocumentId || !sourceFileVersionId) {
      return {
        ...base, action: "COPY", state: "INVALID",
        sourceCadDocumentId: sourceCadDocumentId ?? "", sourceFileVersionId: sourceFileVersionId ?? "",
      };
    }

    const provenLineageSource = lineageBySourceThenTarget.get(entry.resultingCadDocumentId);
    if (provenLineageSource !== sourceCadDocumentId) {
      // Missing lineage entirely, or a lineage row that names a DIFFERENT
      // source than THIS operation entry claims - either way, this
      // resulting identity cannot be proven to genuinely be this entry's
      // copy. Always INVALID, never PENDING.
      return { ...base, action: "COPY", state: "INVALID", sourceCadDocumentId, sourceFileVersionId };
    }

    const versions = versionsByCadDocumentId.get(entry.resultingCadDocumentId) ?? [];
    if (versions.length === 0) {
      return { ...base, action: "COPY", state: "PENDING", sourceCadDocumentId, sourceFileVersionId };
    }
    if (versions.length === 1 && versions[0]!.versionNumber === 1) {
      const row = versions[0]!;
      const fileSize = toSafeFileSize(row.fileSize);
      if (isCanonicalSha256(row.checksum) && fileSize !== null) {
        return {
          ...base,
          action: "COPY",
          state: "MATERIALIZED",
          sourceCadDocumentId,
          sourceFileVersionId,
          fileVersionId: row.id,
          versionNumber: 1,
          sha256: row.checksum,
          fileSize,
        };
      }
      // A lone versionNumber-1 row with missing/non-canonical integrity
      // metadata is never reported as MATERIALIZED - the caller could not
      // verify a local binary against it either way.
      return { ...base, action: "COPY", state: "INVALID", sourceCadDocumentId, sourceFileVersionId };
    }
    // Anything else - zero handled above, multiple rows, or a lone row whose
    // versionNumber isn't 1 - is an unexpected state for a Copy Design
    // target and is always INVALID, never guessed at.
    return { ...base, action: "COPY", state: "INVALID", sourceCadDocumentId, sourceFileVersionId };
  });

  return {
    contract: COPY_DESIGN_OPERATION_STATUS_CONTRACT,
    copyDesignOperationId: operation.id,
    idempotencyKey: operation.idempotencyKey,
    performedAt: operation.performedAt.toISOString(),
    entries,
  };
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface CopyDesignOperationStatusHttpResult {
  status: number;
  body: unknown;
}

export async function copyDesignOperationStatusHttpResult(
  actor: Actor | null,
  operationId: string,
  db: CopyDesignOperationStatusDb,
): Promise<CopyDesignOperationStatusHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }

  try {
    const dto = await loadCopyDesignOperationStatus(db, actor.organizationId, operationId);
    return { status: 200, body: dto };
  } catch (error) {
    if (error instanceof CopyDesignOperationStatusNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    throw error;
  }
}
