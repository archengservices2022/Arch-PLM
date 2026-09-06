/**
 * Arch PDM - frozen release baseline core (P3D-1, extended P3D-3;
 * provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds the domain error and result shapes for capturing a release
 * baseline. The transactional Prisma logic lives in `app/lib/release-db.ts`,
 * which composes this module with:
 *   - the SHARED FileVersion resolver (`app/lib/file-version-resolution-core.ts`
 *     - the SAME algorithm Get Latest, Checkout, and Check-In's stale-base
 *     check already use) - this module does not invent a second "current
 *     version" definition;
 *   - the dependency-closure walk (`app/lib/release-closure-core.ts`).
 *
 * SCOPE (P3D-3): a baseline pins the exact FileVersion of every CadDocument
 * in the release's dependency-complete closure at the moment the revision is
 * RELEASED:
 *   - every CadDocument DIRECTLY associated via ItemRevisionDocument, AND
 *   - the complete outgoing CadDependency closure reachable from those.
 * (P3D-1 froze direct associations only; the closure walk is the P3D-3
 * addition. Historical P3D-1 baselines are never re-expanded.)
 *
 * STORAGE INTEGRITY (P3D-3): before a version is frozen, release verifies the
 * pinned object's ACTUAL bytes - streamed SHA-256 and byte size must equal
 * the FileVersion's own `checksum` / `fileSize`. P3D-1 checked only that an
 * object existed at the key; this is the narrowly-scoped strengthening. It
 * never buffers a whole CAD file and never substitutes another FileVersion.
 */

/** Thrown when one CadDocument in the release closure (direct OR dependency)
 *  cannot be frozen safely. The WHOLE release aborts - never a partial
 *  baseline, never a fallback to an older or newer binary.
 *
 *  - `missing-version`: no binary-backed FileVersion exists at all.
 *  - `missing-binary`: the resolved current FileVersion's object is absent
 *    from storage (or unreadable).
 *  - `corrupt`: the object exists but its actual bytes no longer match the
 *    FileVersion's pinned checksum/size. The message deliberately does NOT
 *    restate the expected or actual digest/size. */
export class ReleaseBaselineIncompleteError extends Error {
  readonly cadDocumentId: string;
  readonly reason: "missing-version" | "missing-binary" | "corrupt";
  constructor(
    cadDocumentId: string,
    reason: "missing-version" | "missing-binary" | "corrupt",
  ) {
    super(
      reason === "missing-version"
        ? `CAD document ${cadDocumentId} has no valid stored binary FileVersion to release`
        : reason === "missing-binary"
          ? `CAD document ${cadDocumentId}'s expected current FileVersion has no stored binary`
          : `CAD document ${cadDocumentId}'s expected current FileVersion failed integrity verification: the stored binary no longer matches its recorded checksum/size`,
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
  inclusionKind: "DIRECT" | "DEPENDENCY";
}

export interface ReleaseBaselineResult {
  id: string;
  itemRevisionId: string;
  createdById: string;
  createdAt: string;
  entries: ReleaseBaselineEntryResult[];
}
