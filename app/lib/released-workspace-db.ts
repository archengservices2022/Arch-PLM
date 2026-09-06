/**
 * Arch PDM - Released Revision retrieval: Prisma-shaped wiring (P3D-2).
 *
 * Deliberately does NOT import "server-only" and takes `db` / `provider` as
 * required parameters, mirroring `get-latest-db.ts` / `workspace-plan-db.ts`
 * / `release-db.ts` exactly, so this module stays loadable by the plain
 * Node test runner with an in-memory fake database. The route surface is
 * `app/lib/released-workspace.ts`, a thin `server-only`-guarded shim.
 *
 * TENANT SCOPING: every query is filtered by `organizationId =
 * actor.organizationId`, taken only from the verified `Actor` the caller
 * passes in - never from a route param.
 *
 * READ-ONLY, NO REPAIR: this module never calls `.update()` / `.delete()` /
 * `.create()` on ItemRevision, ReleaseBaseline, or ReleaseBaselineEntry. A
 * missing or incomplete baseline is reported as a controlled error, never
 * silently repaired, regenerated from "latest", or backfilled from
 * ItemRevisionDocument's live associations.
 *
 * PINNED-VERSION SELECTION (the core rule this module exists to enforce):
 * every entry is derived STRICTLY from ReleaseBaselineEntry.fileVersionId -
 * `resolveCurrentFileVersion` (`file-version-resolution-core.ts`, used by
 * Get Latest / Checkout / Check-In) is never imported or called here. The
 * DB's own composite FK
 * (ReleaseBaselineEntry -> FileVersion(organizationId, cadDocumentId, id) -
 * see `prisma/schema.prisma`'s ReleaseBaselineEntry doc comment) already
 * guarantees the joined FileVersion belongs to the entry's CadDocument; this
 * module still re-verifies that pairing explicitly as defense in depth
 * before trusting it, alongside the storage-existence check `resolveCurrent
 * FileVersion` would otherwise have performed for a DIFFERENT purpose
 * (resolving "current", not verifying "the pinned one is intact").
 *
 * DEPENDENCY-COMPLETE PACKAGE (P3D-3): retrieval returns EVERY
 * ReleaseBaselineEntry for the baseline - both `inclusionKind = DIRECT` and
 * `inclusionKind = DEPENDENCY` - because a released package is the whole
 * frozen dependency closure that `release-db.ts` captured at release time.
 * The provenance tag is passed straight through onto each entry. This module
 * NEVER walks CadDependency, never recomputes the closure, never re-pins:
 * the closure math happened once, at release, and is now immutable history.
 *
 * BACKWARD COMPATIBILITY: a P3D-1 / P3D-2 baseline predates the closure walk;
 * its entries were all direct and the `inclusionKind` column defaults to
 * DIRECT, so such a baseline reads back unchanged - same entries, all tagged
 * DIRECT - and is NEVER expanded using today's CadDependency graph. "What
 * was frozen then" is exactly what comes back now.
 *
 * INTEGRITY IS ALL-OR-NOTHING: unlike Get Latest (which tolerates a partial/
 * unsafe manifest and reports `safe: false` with per-entry problems), a
 * released retrieval that finds ANY pinned entry unusable (FileVersion
 * unresolvable, missing checksum/fileSize, missing stored binary, or the
 * stored binary's ACTUAL bytes no longer matching the pinned checksum/size)
 * aborts the ENTIRE retrieval with a controlled error - never a partial
 * plan, never a substituted newer/older/current version. This reflects that
 * a release baseline is engineering-record evidence, not a best-effort
 * live view.
 *
 * BYTE-LEVEL VERIFICATION (Codex HIGH follow-up): checking that a storage
 * object EXISTS at the pinned key is not the same as proving its bytes
 * still match the immutable FileVersion record - a corrupted or
 * silently-replaced object at the same key would otherwise pass undetected.
 * For every entry this module streams the stored object through
 * `provider.hashObject()` (the SAME primitive `readCadFileVersionForActor`
 * in `app/lib/storage.ts` already uses for download-time integrity - see
 * that function's own verify-then-stream pattern) and requires BOTH the
 * computed SHA-256 and byte size to exactly equal the pinned
 * FileVersion's own `checksum` / `fileSize`. `hashObject` computes both in
 * ONE streamed pass (never buffering the whole file), so this is a single
 * read per entry, not a separate existence check followed by a second read.
 * A storage-layer failure of any kind (object absent, unreadable, etc.) is
 * folded into the SAME controlled `missing-binary` error - the underlying
 * provider error (which could name a physical filesystem path) is never
 * exposed to the caller; a hash/size mismatch is reported as `corrupt`
 * without restating the expected/actual values (never leak what the
 * correct bytes would have hashed to).
 *
 * PERFORMANCE: this makes released retrieval's I/O cost proportional to the
 * total byte size of the frozen package (every pinned object is read once,
 * whole, in memory-bounded streaming fashion) - unlike Get Latest / the
 * working workspace-plan, which only check object EXISTENCE. This is
 * intentional and is NOT optimized away in P3D-2: verifying that released,
 * immutable engineering evidence has not silently rotted or been tampered
 * with is more important here than matching Get Latest's cheaper check.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import { LifecycleState } from "../generated/prisma/enums.ts";
import { workspaceRelativePath } from "./get-latest-core.ts";
import type { StorageProvider } from "./storage-core.ts";
import {
  ItemRevisionNotFoundError,
  RELEASED_WORKSPACE_CONTRACT_ID,
  RELEASED_WORKSPACE_CONTRACT_VERSION,
  ReleaseBaselineMissingError,
  ReleasedBinaryIntegrityError,
  RevisionNotReleasedError,
  type ReleasedWorkspacePlan,
  type ReleasedWorkspacePlanEntry,
} from "./released-workspace-core.ts";

export {
  ItemRevisionNotFoundError,
  ReleaseBaselineMissingError,
  ReleasedBinaryIntegrityError,
  RevisionNotReleasedError,
};
export type { ReleasedWorkspacePlan };

/** The slice of PrismaClient this module needs. */
export type ReleasedWorkspaceDb = Pick<
  PrismaClient,
  "itemRevision" | "releaseBaseline" | "releaseBaselineEntry"
>;

/**
 * Retrieve the frozen released-workspace plan for `itemRevisionId`, scoped
 * to `actor`'s organization.
 *
 * @throws ItemRevisionNotFoundError if the revision doesn't exist in the
 *   actor's organization (also how cross-tenant access surfaces).
 * @throws RevisionNotReleasedError if the revision exists but its lifecycle
 *   is not RELEASED.
 * @throws ReleaseBaselineMissingError if the revision is RELEASED but has no
 *   ReleaseBaseline row (a data-integrity error - see the module doc
 *   comment; never falls back to ItemRevisionDocument's live associations).
 * @throws ReleasedBinaryIntegrityError if any pinned ReleaseBaselineEntry
 *   fails verification (unresolvable FileVersion, missing checksum/
 *   fileSize, missing stored binary, or the stored binary's actual
 *   SHA-256/byte size no longer matching the pinned FileVersion). Never
 *   falls back to a newer, older, or current Get-Latest version.
 */
export async function getReleasedWorkspacePlanForActor(
  actor: Actor,
  itemRevisionId: string,
  db: ReleasedWorkspaceDb,
  provider: StorageProvider,
): Promise<ReleasedWorkspacePlan> {
  const revision = await db.itemRevision.findFirst({
    where: { id: itemRevisionId, organizationId: actor.organizationId },
    select: { id: true, lifecycle: true },
  });
  if (!revision) {
    throw new ItemRevisionNotFoundError();
  }
  if (revision.lifecycle !== LifecycleState.RELEASED) {
    throw new RevisionNotReleasedError();
  }

  const baseline = await db.releaseBaseline.findFirst({
    where: { organizationId: actor.organizationId, itemRevisionId: revision.id },
    select: { id: true, createdAt: true, createdById: true },
  });
  if (!baseline) {
    throw new ReleaseBaselineMissingError();
  }

  // Deterministic ordering: CadDocument ID ascending, entry id as a stable
  // tiebreak (never database natural order). Ties cannot actually occur
  // given @@unique([releaseBaselineId, cadDocumentId]), but the tiebreak
  // costs nothing and keeps the guarantee explicit rather than incidental.
  const rows = await db.releaseBaselineEntry.findMany({
    where: { organizationId: actor.organizationId, releaseBaselineId: baseline.id },
    orderBy: [{ cadDocumentId: "asc" }, { id: "asc" }],
    select: {
      cadDocumentId: true,
      fileVersionId: true,
      inclusionKind: true,
      cadDocument: {
        select: { documentNumber: true, fileName: true, documentType: true },
      },
      fileVersion: {
        select: {
          id: true,
          cadDocumentId: true,
          versionNumber: true,
          checksum: true,
          fileSize: true,
          storageKey: true,
          originalFileName: true,
        },
      },
    },
  });

  const entries: ReleasedWorkspacePlanEntry[] = [];
  for (const row of rows) {
    const fv = row.fileVersion;
    // Defense in depth: the composite FK already guarantees fv.cadDocumentId
    // === row.cadDocumentId at the database level - re-verify explicitly
    // rather than assuming a FK alone proves it at every future call site.
    if (!fv || fv.cadDocumentId !== row.cadDocumentId) {
      throw new ReleasedBinaryIntegrityError(
        row.cadDocumentId,
        row.fileVersionId,
        "missing-file-version",
      );
    }

    const fileSize = fv.fileSize == null ? null : Number(fv.fileSize);
    if (
      typeof fv.checksum !== "string" ||
      fv.checksum.length === 0 ||
      fileSize == null ||
      !Number.isFinite(fileSize) ||
      fileSize < 0
    ) {
      throw new ReleasedBinaryIntegrityError(row.cadDocumentId, fv.id, "missing-metadata");
    }

    // Verify the ACTUAL stored bytes, not just that an object exists at the
    // key: hashObject streams the object through SHA-256 (never buffering
    // it whole) and returns both the digest and the byte size in one pass,
    // so this is a single read - not "check existence, then hash" and not
    // "hash, then read again for size". A storage-layer failure (including
    // the object being absent) is reported as the SAME controlled
    // missing-binary integrity error - the underlying provider error (which
    // could name a physical path) is never exposed to the caller.
    let verified: { sha256: string; size: number };
    try {
      verified = await provider.hashObject(fv.storageKey);
    } catch {
      throw new ReleasedBinaryIntegrityError(row.cadDocumentId, fv.id, "missing-binary");
    }

    if (verified.sha256 !== fv.checksum || verified.size !== fileSize) {
      throw new ReleasedBinaryIntegrityError(row.cadDocumentId, fv.id, "corrupt");
    }

    entries.push({
      cadDocumentId: row.cadDocumentId,
      documentNumber: row.cadDocument.documentNumber,
      fileName: row.cadDocument.fileName,
      cadType: String(row.cadDocument.documentType),
      // A released package identifies itself by ItemRevision + baseline, not
      // by a single graph "root" - so no entry is marked isRoot (see the
      // adapter and released-workspace-core doc comments).
      isRoot: false,
      // P3D-3 provenance: DIRECT (associated with the revision) vs DEPENDENCY
      // (reached through the frozen CadDependency closure). Read straight
      // from the immutable baseline row - never recomputed.
      inclusionKind: row.inclusionKind,
      placement: {
        generatedRelativePath: workspaceRelativePath(
          row.cadDocument.fileName,
          row.cadDocument.documentNumber,
        ),
      },
      // The baseline pins (document, version) pairs, not edges - the frozen
      // closure's edge structure is not stored and is never recomputed at
      // read time, so per-entry dependsOn is intentionally empty.
      dependsOn: [],
      canMaterialize: true,
      blockedReasons: [],
      version: {
        fileVersionId: fv.id,
        versionNumber: fv.versionNumber,
        checksum: fv.checksum,
        fileSize,
        originalFileName: fv.originalFileName,
        contentPath: `/api/file-versions/${fv.id}/content`,
      },
    });
  }

  return {
    contract: {
      id: RELEASED_WORKSPACE_CONTRACT_ID,
      version: RELEASED_WORKSPACE_CONTRACT_VERSION,
    },
    itemRevision: { id: revision.id },
    releaseBaseline: {
      id: baseline.id,
      createdAt: baseline.createdAt.toISOString(),
      createdById: baseline.createdById,
    },
    generatedAt: new Date().toISOString(),
    documentCount: entries.length,
    safe: true,
    entries,
    problems: [],
  };
}

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

export interface ReleasedWorkspaceHttpResult {
  status: number;
  body: unknown;
}

function isValidItemRevisionId(itemRevisionId: string): boolean {
  return (
    typeof itemRevisionId === "string" &&
    itemRevisionId.length > 0 &&
    itemRevisionId.length <= 200
  );
}

/**
 * Map an authenticated (or unauthenticated) released-workspace request to an
 * HTTP status + JSON body. Kept out of the route handler so it is
 * unit-testable without a running server.
 *
 * Status mapping (documented here, not just implied by the code):
 *   401 unauthenticated; 404 revision not found / cross-tenant; 409 the
 *   revision exists but is not RELEASED (a state mismatch, not a data
 *   defect - the same family as "not currently checked out" elsewhere in
 *   this app); 422 a genuine data-integrity problem with the frozen
 *   baseline itself (missing baseline row, or a pinned entry that fails
 *   verification) - not something a client retry can fix, matching
 *   `NoValidFileVersionError`'s existing 422 precedent in checkout.
 */
export async function getReleasedWorkspaceHttpResult(
  actor: Actor | null,
  itemRevisionId: string,
  db: ReleasedWorkspaceDb,
  provider: StorageProvider,
): Promise<ReleasedWorkspaceHttpResult> {
  if (!actor) {
    return { status: 401, body: { error: "Authentication required" } };
  }
  if (!isValidItemRevisionId(itemRevisionId)) {
    return { status: 400, body: { error: "Invalid item revision id" } };
  }

  try {
    const plan = await getReleasedWorkspacePlanForActor(actor, itemRevisionId, db, provider);
    return { status: 200, body: plan };
  } catch (error) {
    if (error instanceof ItemRevisionNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    if (error instanceof RevisionNotReleasedError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof ReleaseBaselineMissingError) {
      return { status: 422, body: { error: error.message } };
    }
    if (error instanceof ReleasedBinaryIntegrityError) {
      return { status: 422, body: { error: error.message } };
    }
    throw error;
  }
}
