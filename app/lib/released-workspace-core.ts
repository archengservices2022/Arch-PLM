/**
 * Arch PDM - Released Revision retrieval core (P3D-2, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds the versioned contract, domain errors, and result shape for
 * retrieving a RELEASED ItemRevision's frozen engineering baseline. The
 * transactional Prisma logic lives in `app/lib/released-workspace-db.ts`.
 *
 * CRITICAL RULE: this contract is built EXCLUSIVELY from the immutable
 * ReleaseBaselineEntry rows a P3D-1 release already froze - never from
 * `resolveCurrentFileVersion` or any other "what is current" resolution.
 * `ReleaseBaselineEntry.fileVersionId` is the sole, authoritative identity
 * for what a released document resolves to; a later FileVersion on the same
 * CadDocument must never be substituted, silently or otherwise.
 *
 * CONTRACT REUSE: entries reuse `WorkspacePlanEntry` (and transitively
 * `WorkspacePlanVersion` / `WorkspacePlanPlacement`) from
 * `app/lib/workspace-plan-core.ts` VERBATIM - the same shape the existing,
 * unmodified `materializeWorkspacePlan` (P3B-2B) already knows how to
 * consume. This is a DELIBERATELY separate, honestly-named contract
 * (`arch-plm.released-workspace-plan`, not `arch-plm.cad-workspace-plan`) -
 * a released retrieval identifies itself by ItemRevision + ReleaseBaseline,
 * not by a single graph "root" CadDocument, and integrity failures ABORT
 * the whole retrieval rather than being reported per-entry the way Get
 * Latest tolerates a partial/unsafe manifest. Feeding a
 * `ReleasedWorkspacePlan` to the EXISTING materializer (unchanged) is a
 * small adapter's job at the call site (see `cli/released-workspace-adapter.ts`),
 * not this module's.
 */
import type { WorkspacePlanEntry } from "./workspace-plan-core.ts";

/** Provenance of a pinned entry in a P3D-3 dependency-complete baseline:
 *  DIRECT = the CadDocument was associated with the ItemRevision at release
 *  time; DEPENDENCY = it was pulled in through the CadDependency closure.
 *  P3D-1 baselines predate the closure walk - every entry reads back DIRECT.
 *  A future client that does not know this field can safely ignore it (it is
 *  purely additive - no contract version bump). */
export type ReleaseBaselineInclusionKind = "DIRECT" | "DEPENDENCY";

export const RELEASED_WORKSPACE_CONTRACT_ID = "arch-plm.released-workspace-plan";
export const RELEASED_WORKSPACE_CONTRACT_VERSION = "1.0.0";

const SUPPORTED_RELEASED_CONTRACT_MAJOR = Number(
  RELEASED_WORKSPACE_CONTRACT_VERSION.split(".")[0],
);

/** Mirrors `workspace-materialize-core.ts`'s `isSupportedWorkspaceContractVersion`,
 *  but keyed to THIS module's own `RELEASED_WORKSPACE_CONTRACT_VERSION` -
 *  deliberately NOT the working-plan constant, so the two contracts can
 *  version independently without one silently validating the other's
 *  major-version bump incorrectly. */
export function isSupportedReleasedWorkspaceContractVersion(version: string): boolean {
  const major = Number(String(version).split(".")[0]);
  return Number.isInteger(major) && major === SUPPORTED_RELEASED_CONTRACT_MAJOR;
}

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class ItemRevisionNotFoundError extends Error {
  constructor() {
    super("Item revision not found in your organization");
    this.name = "ItemRevisionNotFoundError";
  }
}

/** Thrown when the revision exists (tenant-scoped) but is not RELEASED - a
 *  released retrieval never constructs a plan from working/in-review/
 *  approved state. */
export class RevisionNotReleasedError extends Error {
  constructor() {
    super("This item revision is not RELEASED");
    this.name = "RevisionNotReleasedError";
  }
}

/** A RELEASED revision with no ReleaseBaseline row is an integrity error,
 *  not a "nothing to show" case - P3D-1 guarantees a RELEASED transition
 *  always creates a baseline atomically. This must NEVER fall back to
 *  ItemRevisionDocument's live associations. */
export class ReleaseBaselineMissingError extends Error {
  constructor() {
    super(
      "This item revision is RELEASED but has no release baseline - " +
        "this is a data-integrity error, not a retryable condition",
    );
    this.name = "ReleaseBaselineMissingError";
  }
}

export type ReleasedBinaryIntegrityReason =
  | "missing-file-version"
  | "missing-metadata"
  | "missing-binary"
  | "corrupt";

/** Thrown when ANY pinned ReleaseBaselineEntry fails integrity verification.
 *  Aborts the ENTIRE retrieval - never substitutes a newer, older, or
 *  current Get-Latest version for the failing entry, and never returns a
 *  partial plan missing just that document. */
export class ReleasedBinaryIntegrityError extends Error {
  readonly cadDocumentId: string;
  readonly fileVersionId: string | null;
  readonly reason: ReleasedBinaryIntegrityReason;
  constructor(
    cadDocumentId: string,
    fileVersionId: string | null,
    reason: ReleasedBinaryIntegrityReason,
  ) {
    super(
      reason === "missing-file-version"
        ? `Released baseline entry for CAD document ${cadDocumentId} references a FileVersion that could not be resolved`
        : reason === "missing-metadata"
          ? `Released baseline entry for CAD document ${cadDocumentId} is missing checksum/fileSize metadata`
          : reason === "missing-binary"
            ? `Released baseline entry for CAD document ${cadDocumentId} has no stored binary at its pinned FileVersion`
            : `Released baseline entry for CAD document ${cadDocumentId} failed integrity verification: the stored binary no longer matches its pinned FileVersion`,
    );
    this.name = "ReleasedBinaryIntegrityError";
    this.cadDocumentId = cadDocumentId;
    this.fileVersionId = fileVersionId;
    this.reason = reason;
  }
}

// ------------------------------------------------------------
// Contract shape
// ------------------------------------------------------------

/** A released-plan entry: the EXACT `WorkspacePlanEntry` shape the existing
 *  materializer consumes, plus this baseline's own provenance tag. The extra
 *  field is inert for the materializer and the CLI adapter. */
export type ReleasedWorkspacePlanEntry = WorkspacePlanEntry & {
  inclusionKind: ReleaseBaselineInclusionKind;
};

export interface ReleasedWorkspacePlan {
  contract: { id: string; version: string };
  itemRevision: { id: string };
  releaseBaseline: { id: string; createdAt: string; createdById: string };
  generatedAt: string;
  documentCount: number;
  /** Always `true`: unlike a working WorkspacePlan, an integrity failure in
   *  ANY entry aborts the whole retrieval (see ReleasedBinaryIntegrityError)
   *  rather than being reported here with `safe: false`. Present for
   *  structural consistency with WorkspacePlan, not because it can vary. */
  safe: true;
  /** Deterministic order: CadDocument ID ascending (ties broken by entry id -
   *  see `released-workspace-db.ts`), never database natural order. Includes
   *  BOTH DIRECT and DEPENDENCY entries - a released package is the whole
   *  frozen closure. */
  entries: ReleasedWorkspacePlanEntry[];
  /** Always empty - see `safe`'s doc comment. Present for structural
   *  consistency with WorkspacePlan. */
  problems: [];
}
