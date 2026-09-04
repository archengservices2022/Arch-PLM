/**
 * Arch PDM - Managed Workspace Plan contract (P3B-2A).
 *
 * Pure module: no `@/` imports (only relative, explicitly-`.ts`-typed sibling
 * imports so it stays loadable by the plain Node test runner), no Prisma, no
 * framework. It derives a deterministic, versioned "workspace plan" for a
 * future Windows/Inventor CAD Connect client FROM an already-computed,
 * authenticated, tenant-safe Get Latest manifest (`app/lib/get-latest-core.ts`).
 *
 * This module performs NO new database or storage lookups of its own - every
 * fact in the plan already came from the vetted Get Latest pipeline (tenant
 * scoping, graph traversal, latest-binary resolution, path-collision
 * detection). It only reshapes that result into the contract a future client
 * needs, and re-validates the one thing it must never blindly trust: the
 * generated workspace path.
 *
 * IDENTITY CONTRACT
 *   `cadDocumentId` and (when present) `version.fileVersionId` are the ONLY
 *   authoritative identities in this contract. `documentNumber`, `fileName`
 *   and the generated workspace placement path are informational/display
 *   only and MUST NEVER be used as a lookup key or treated as identity.
 *
 * PLACEMENT vs. INVENTOR REFERENCE PATHS
 *   `placement.generatedRelativePath` is a SERVER-GENERATED, flat, safe
 *   relative path for a future client's local workspace layout. It has no
 *   bearing on - and must never be confused with - an Inventor project's own
 *   (.ipj) relative reference structure. The current schema does NOT store
 *   original Inventor reference paths, and this module deliberately invents
 *   none. A future contract MAY add a separate, clearly-named field carrying
 *   real Inventor-sourced reference-path metadata; until then no such field
 *   exists here, generated or otherwise.
 *
 * SAFETY
 *   `safe` is false whenever any document required by the graph could not be
 *   resolved to a real stored binary FileVersion, whenever two documents
 *   collide on the same generated workspace path (case-insensitive), whenever
 *   a dependency points outside the tenant (dangling), or whenever a
 *   generated path fails re-validation here. A plan that is not `safe` must
 *   not be materialized; entries are never silently dropped, overwritten or
 *   auto-renamed to route around a problem.
 *
 * This module never mutates ItemRevision, lifecycle, CadDocument, FileVersion
 * or CadDependency data - it only reads an in-memory manifest object and
 * returns a new plain object.
 */
import {
  assertSafeWorkspacePath,
  type GetLatestManifest,
  type ManifestEntry,
  type ManifestProblem,
  type ManifestProblemKind,
} from "./get-latest-core.ts";

// ------------------------------------------------------------
// Contract identity + version
// ------------------------------------------------------------

/**
 * Bump `WORKSPACE_PLAN_CONTRACT_VERSION` (semver) whenever the SHAPE or the
 * MEANING of an existing field changes in a way an older CAD Connect client
 * could misinterpret (e.g. renaming/removing a field, changing what `safe`
 * means, changing an existing enum's values). Purely additive, backward
 * compatible fields (a new optional field, a new enum member a client can
 * safely ignore) do not require a bump.
 *
 * A future client should refuse to materialize a plan whose `contract.id` it
 * does not recognize, or whose `contract.version` major component it does
 * not support.
 */
export const WORKSPACE_PLAN_CONTRACT_ID = "arch-plm.cad-workspace-plan";
export const WORKSPACE_PLAN_CONTRACT_VERSION = "1.0.0";

// ------------------------------------------------------------
// Output shape
// ------------------------------------------------------------

/** Reasons a single entry cannot be materialized, plus this layer's own
 *  defense-in-depth path re-validation failure. */
export type WorkspacePlanBlockReason = ManifestProblemKind | "unsafe-path";

export interface WorkspacePlanProblem {
  kind: WorkspacePlanBlockReason;
  message: string;
  cadDocumentId?: string;
  cadDocumentIds?: string[];
  workspacePath?: string;
}

export interface WorkspacePlanVersion {
  /** Authoritative identity of the exact stored binary this entry pins. */
  fileVersionId: string;
  versionNumber: number;
  checksum: string;
  fileSize: number;
  /** Display only - never identity. */
  originalFileName: string;
  /** The EXISTING authenticated, tenant-scoped download endpoint. This
   *  contract never streams or bundles bytes itself. */
  contentPath: string;
}

export interface WorkspacePlanPlacement {
  /**
   * Server-generated, flat, safe relative path a future client MAY use to
   * place this document's file in a local workspace. This is NOT an Inventor
   * project-relative reference path - the schema does not store one, and
   * none is invented here. Never treat this as identity.
   */
  generatedRelativePath: string;
}

export interface WorkspacePlanEntry {
  /** Authoritative identity. */
  cadDocumentId: string;
  /** Display only - never identity. */
  documentNumber: string;
  /** Display only - never identity. */
  fileName: string;
  cadType: string;
  isRoot: boolean;
  placement: WorkspacePlanPlacement;
  /** Outgoing parent -> child edges to other entries IN this plan
   *  (deduplicated, deterministically ordered) - preserved so a future
   *  client can understand parent -> child references. */
  dependsOn: Array<{ cadDocumentId: string; dependencyType: string }>;
  /** True iff this entry pins a real, safely-placeable FileVersion. */
  canMaterialize: boolean;
  /** Reasons THIS entry cannot be materialized. Empty iff canMaterialize. */
  blockedReasons: WorkspacePlanBlockReason[];
  /** Present iff canMaterialize; null otherwise. */
  version: WorkspacePlanVersion | null;
}

export interface WorkspacePlan {
  contract: { id: string; version: string };
  root: { cadDocumentId: string };
  generatedAt: string;
  documentCount: number;
  /** True iff every entry can materialize AND there are no path collisions
   *  or dangling dependencies anywhere in the graph. False means the plan is
   *  incomplete/unsafe to materialize as-is. */
  safe: boolean;
  entries: WorkspacePlanEntry[];
  /** Full diagnostic detail, including graph-level problems (e.g. a dangling
   *  dependency) not attributable to a single entry's own materializability. */
  problems: WorkspacePlanProblem[];
  traversal: { visitedCount: number; edgeCount: number; maxNodes: number };
}

// ------------------------------------------------------------
// Transform
// ------------------------------------------------------------

/** Problem kinds that block THIS document's own materialization. A dangling
 *  dependency is a graph-completeness problem about a *referenced* document,
 *  not about this entry's own file, so it is surfaced only in the top-level
 *  `problems` list (still making the overall plan unsafe). */
const ENTRY_BLOCK_KINDS: ReadonlySet<ManifestProblemKind> = new Set([
  "missing-version",
  "missing-binary",
  "path-collision",
]);

function isSafePath(path: string): boolean {
  try {
    assertSafeWorkspacePath(path);
    return true;
  } catch {
    return false;
  }
}

function buildEntry(manifestEntry: ManifestEntry): {
  entry: WorkspacePlanEntry;
  unsafePathProblem: WorkspacePlanProblem | null;
} {
  const blockedReasons: WorkspacePlanBlockReason[] =
    manifestEntry.problems.filter((kind) => ENTRY_BLOCK_KINDS.has(kind));

  let generatedRelativePath = manifestEntry.workspacePath;
  let unsafePathProblem: WorkspacePlanProblem | null = null;

  // Defense in depth: never trust an upstream workspace path as authoritative
  // without re-validating it here, even though the Get Latest pipeline
  // already guarantees safety. If re-validation ever fails, block the entry
  // instead of exposing or materializing the unsafe value.
  if (!isSafePath(generatedRelativePath)) {
    blockedReasons.push("unsafe-path");
    unsafePathProblem = {
      kind: "unsafe-path",
      cadDocumentId: manifestEntry.cadDocumentId,
      workspacePath: generatedRelativePath,
      message:
        `Generated workspace path for ${manifestEntry.documentNumber} ` +
        "failed re-validation and was blocked.",
    };
    generatedRelativePath = manifestEntry.cadDocumentId;
  }

  const canMaterialize =
    manifestEntry.version !== null && blockedReasons.length === 0;

  const version: WorkspacePlanVersion | null =
    canMaterialize && manifestEntry.version
      ? {
          fileVersionId: manifestEntry.version.fileVersionId,
          versionNumber: manifestEntry.version.versionNumber,
          checksum: manifestEntry.version.checksum,
          fileSize: manifestEntry.version.fileSize,
          originalFileName: manifestEntry.version.originalFileName,
          contentPath: manifestEntry.version.contentPath,
        }
      : null;

  return {
    entry: {
      cadDocumentId: manifestEntry.cadDocumentId,
      documentNumber: manifestEntry.documentNumber,
      fileName: manifestEntry.fileName,
      cadType: manifestEntry.cadType,
      isRoot: manifestEntry.isRoot,
      placement: { generatedRelativePath },
      dependsOn: manifestEntry.dependsOn,
      canMaterialize,
      blockedReasons,
      version,
    },
    unsafePathProblem,
  };
}

function sortProblems(problems: WorkspacePlanProblem[]): WorkspacePlanProblem[] {
  return [...problems].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.cadDocumentId ?? "").localeCompare(b.cadDocumentId ?? "") ||
      (a.workspacePath ?? "").localeCompare(b.workspacePath ?? ""),
  );
}

/**
 * Derive a deterministic, versioned workspace plan from an already-built,
 * tenant-safe Get Latest manifest. Pure and synchronous: no I/O, no new
 * database/storage lookups - every fact here was already produced by the
 * authenticated Get Latest pipeline. Never accepts (and has no parameter for)
 * a client-supplied organization id, storage key or authoritative path.
 */
export function buildWorkspacePlanFromManifest(
  manifest: GetLatestManifest,
): WorkspacePlan {
  const entries: WorkspacePlanEntry[] = [];
  const extraProblems: WorkspacePlanProblem[] = [];

  for (const manifestEntry of manifest.entries) {
    const { entry, unsafePathProblem } = buildEntry(manifestEntry);
    entries.push(entry);
    if (unsafePathProblem) {
      extraProblems.push(unsafePathProblem);
    }
  }

  const passthroughProblems: WorkspacePlanProblem[] = manifest.problems.map(
    (problem: ManifestProblem) => ({ ...problem }),
  );

  const problems = sortProblems([...passthroughProblems, ...extraProblems]);

  return {
    contract: {
      id: WORKSPACE_PLAN_CONTRACT_ID,
      version: WORKSPACE_PLAN_CONTRACT_VERSION,
    },
    root: manifest.root,
    generatedAt: manifest.generatedAt,
    documentCount: manifest.documentCount,
    safe: problems.length === 0,
    entries,
    problems,
    traversal: manifest.traversal,
  };
}
