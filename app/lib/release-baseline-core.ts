/**
 * Arch PDM - frozen release baseline core (P3D-1, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds the domain error and result shapes for capturing a release
 * baseline. The transactional Prisma logic lives in `app/lib/release-db.ts`,
 * which composes this module with the SHARED FileVersion resolver
 * (`app/lib/file-version-resolution-core.ts` - the SAME algorithm Get
 * Latest, Checkout, and Check-In's stale-base check already use) - this
 * module does not invent a second "current version" definition.
 *
 * SCOPE (P3D-1): a baseline pins the exact FileVersion of every CadDocument
 * DIRECTLY associated with an ItemRevision via ItemRevisionDocument at the
 * moment that revision is RELEASED. It does NOT walk the CadDependency
 * graph - that closure/reproducibility validation is later P3D work.
 */

/** Thrown when the current usable FileVersion for one of the directly
 *  associated CadDocuments cannot be resolved (no binary-backed version at
 *  all, or the expected newest one's binary is missing from storage). The
 *  WHOLE release aborts - never a partial baseline, never a fallback to an
 *  older binary. */
export class ReleaseBaselineIncompleteError extends Error {
  readonly cadDocumentId: string;
  readonly reason: "missing-version" | "missing-binary";
  constructor(cadDocumentId: string, reason: "missing-version" | "missing-binary") {
    super(
      reason === "missing-version"
        ? `CAD document ${cadDocumentId} has no valid stored binary FileVersion to release`
        : `CAD document ${cadDocumentId}'s expected current FileVersion has no stored binary`,
    );
    this.name = "ReleaseBaselineIncompleteError";
    this.cadDocumentId = cadDocumentId;
    this.reason = reason;
  }
}

export interface ReleaseBaselineEntryResult {
  cadDocumentId: string;
  fileVersionId: string;
  versionNumber: number;
}

export interface ReleaseBaselineResult {
  id: string;
  itemRevisionId: string;
  createdById: string;
  createdAt: string;
  entries: ReleaseBaselineEntryResult[];
}
