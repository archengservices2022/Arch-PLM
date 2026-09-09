/**
 * Arch PDM - shared "current usable FileVersion" resolver (provider-agnostic
 * core).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. This is the SINGLE definition of "what is the current, usable
 * FileVersion for a CadDocument" used by every read path that needs it:
 * Get Latest (`app/lib/get-latest-core.ts`), Checkout base-version selection
 * (`app/lib/checkout-core.ts`), and Check-In's stale-base validation
 * (`app/lib/checkin-db.ts`). Before P3C-2's Codex review, Get Latest and
 * Checkout independently re-implemented the identical algorithm and
 * Check-In's stale-base check used a DIFFERENT, weaker one (the raw
 * numerically-newest row, without checking metadata completeness or binary
 * existence) - three copies that could silently drift apart. This module is
 * the fix: one algorithm, extracted, that all three now call.
 *
 * SEMANTICS (never change these without updating all three call sites):
 *   - order candidates newest versionNumber first;
 *   - skip any row that is not metadata-complete (checksum + finite
 *     non-negative fileSize) - a newer metadata-incomplete row never blocks
 *     resolution of an older complete one, and is never itself resolved;
 *   - the first metadata-complete row, newest first, is "the current
 *     version" - ONLY that row's binary presence is checked;
 *   - if that row's binary is missing from storage, resolution reports
 *     `missing-binary` for THAT row - it never falls back to an older,
 *     still-present binary. Shipping stale bytes labeled "current" would be
 *     an integrity violation, so this is reported as a problem instead.
 */

export const DEFAULT_MAX_VERSIONS_SCANNED = 500;

/** The minimal shape resolution needs. Callers may pass a richer row type
 *  (e.g. Get Latest's `ManifestVersionRow`, which also carries
 *  `originalFileName`) - the resolved row keeps its original, full type. */
export interface FileVersionResolutionRow {
  id: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: number | null;
  storageKey: string;
}

export interface FileVersionResolutionDeps<
  T extends FileVersionResolutionRow,
> {
  /** Tenant-scoped, newest versionNumber first, already capped by the caller. */
  loadVersionsNewestFirst(cadDocumentId: string): Promise<T[]>;
  /** True when the stored binary object for `storageKey` actually exists. */
  objectExists(storageKey: string): Promise<boolean>;
  maxVersionsScanned?: number;
}

export type FileVersionResolution<T extends FileVersionResolutionRow> =
  | { kind: "ok"; row: T }
  | { kind: "missing-version" }
  | { kind: "missing-binary"; row: T };

/** A version row is a real, immutable binary version iff it carries a
 *  server-computed checksum and byte size (the metadata-only creation path
 *  that produced neither was removed in P3A-1).
 *
 *  Only the integrity fields are inspected, so any row-shaped value that
 *  carries them is accepted - the desktop authoritative-latest-version lookup
 *  reuses this exact predicate to decide whether a recognised latest
 *  FileVersion has usable integrity metadata. */
export function isBinaryBackedFileVersion(
  row: Pick<FileVersionResolutionRow, "checksum" | "fileSize">,
): boolean {
  return (
    typeof row.checksum === "string" &&
    row.checksum.length > 0 &&
    typeof row.fileSize === "number" &&
    Number.isFinite(row.fileSize) &&
    row.fileSize >= 0
  );
}

/**
 * Resolve a CadDocument's current usable FileVersion - see the module doc
 * comment above for the exact semantics. This is intentionally the ONLY
 * place this algorithm is implemented.
 */
export async function resolveCurrentFileVersion<
  T extends FileVersionResolutionRow,
>(
  cadDocumentId: string,
  deps: FileVersionResolutionDeps<T>,
): Promise<FileVersionResolution<T>> {
  const maxScan = deps.maxVersionsScanned ?? DEFAULT_MAX_VERSIONS_SCANNED;
  const rows = (await deps.loadVersionsNewestFirst(cadDocumentId)).slice(
    0,
    maxScan,
  );

  const latest = rows.find(isBinaryBackedFileVersion);
  if (!latest) {
    return { kind: "missing-version" };
  }

  const exists = await deps.objectExists(latest.storageKey);
  return exists
    ? { kind: "ok", row: latest }
    : { kind: "missing-binary", row: latest };
}
