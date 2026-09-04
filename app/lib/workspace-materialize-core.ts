/**
 * Arch PDM - Managed Workspace Materialization core (P3B-2B).
 *
 * Pure(ish) module: no `@/` imports (only relative, explicitly-`.ts`-typed
 * sibling imports so it stays loadable by the plain Node test runner), no
 * Prisma, no framework, no HTTP client, no dependency on the Get Latest /
 * workspace-plan-building pipeline. It safely materializes an
 * ALREADY-GENERATED `WorkspacePlan` (`app/lib/workspace-plan-core.ts`) onto a
 * local filesystem for a future Windows Arch CAD Connect client.
 *
 * This milestone does NOT integrate Autodesk Inventor. It only downloads and
 * places exact, pinned, checksum-verified files.
 *
 * ARCHITECTURE INVARIANTS
 *   - The server / object storage remains authoritative. This module never
 *     mutates ItemRevision, lifecycle, CadDocument, FileVersion or
 *     CadDependency data, and creates no authoritative local database.
 *   - `cadDocumentId` and `fileVersionId` are the only authoritative
 *     identities. Local paths and filenames are never identity.
 *   - A `WorkspacePlan` pins EXACT FileVersion ids for one Get operation.
 *     This module has no dependency on (and cannot call) the Get Latest /
 *     workspace-plan-building pipeline - it only ever downloads the EXACT
 *     `version.contentPath` a plan entry already pins. "Latest" is never
 *     re-resolved while materializing a plan.
 *   - `placement.generatedRelativePath` is never treated as - or used to
 *     infer - an Inventor project-relative reference path.
 *   - THIS MILESTONE materializes a single flat filename per entry only -
 *     no nested/subfolder placement. Arch does not yet store real Inventor
 *     relative-reference paths, so a nested path is refused rather than
 *     guessed at (see `resolveWithinWorkspaceRoot`).
 *   - Every pinned `version.contentPath` is checked to be EXACTLY the
 *     existing authenticated `/api/file-versions/<fileVersionId>/content`
 *     endpoint for its OWN fileVersionId before any download is attempted -
 *     never an arbitrary URL/path from a hand-built or otherwise untrusted
 *     plan.
 *
 * REQUIRED FLOW (per entry)
 *   WorkspacePlan -> validate plan -> download exact pinned FileVersion ->
 *   temporary file -> verify expected byte size -> verify expected SHA-256 ->
 *   atomic promotion -> managed local file.
 *
 * The workspace root is supplied by the caller (the trusted desktop/
 * application layer) as a plain parameter - it is never read from the plan.
 * Every `generatedRelativePath` is re-validated (defense in depth - the same
 * posture `workspace-plan-core.ts` takes) and resolved strictly underneath
 * that root using Windows (`path.win32`) semantics, with a case-insensitive
 * containment check.
 *
 * EXISTING-FILE BEHAVIOR (no checkout semantics yet)
 *   - Existing file with the SAME checksum as the pinned FileVersion:
 *     "already-current" - no download, no write.
 *   - Existing file with a DIFFERENT checksum: never overwritten. Reported
 *     as "blocked" (local conflict) so a possible user edit is protected
 *     until real checkout/check-in semantics exist.
 *
 * FAILURE BEHAVIOR
 *   Any download/hash/size/write failure leaves no valid-looking final file
 *   at the target path, best-effort removes temporary artifacts, and is
 *   reported as "failed" with a human-readable reason. Nothing is ever
 *   promoted before both size and checksum are confirmed to match the plan.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, link, mkdir, open, rm, stat } from "node:fs/promises";
import { win32 as pathWin32 } from "node:path";
import type { Readable } from "node:stream";

import { assertSafeWorkspacePath } from "./get-latest-core.ts";
import {
  WORKSPACE_PLAN_CONTRACT_ID,
  WORKSPACE_PLAN_CONTRACT_VERSION,
  type WorkspacePlan,
  type WorkspacePlanEntry,
} from "./workspace-plan-core.ts";

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

/** Thrown by `materializeWorkspacePlan` itself (never per-entry): the whole
 *  operation is refused, nothing is downloaded or written. */
export class UnsafeWorkspacePlanError extends Error {
  constructor() {
    super(
      "Refusing to materialize: the workspace plan is not safe/complete " +
        "(plan.safe !== true)",
    );
    this.name = "UnsafeWorkspacePlanError";
  }
}

export class UnsupportedWorkspaceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedWorkspaceContractError";
  }
}

export class WorkspaceRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRootError";
  }
}

/** A placement path failed re-validation or would resolve outside the
 *  workspace root. Surfaced per-entry as a "blocked" result - never thrown
 *  out of `materializeWorkspacePlan`. */
export class WorkspacePathEscapeError extends Error {
  constructor(relativePath: string, reason: string) {
    super(
      `Workspace placement path is unsafe (${reason}): ${JSON.stringify(relativePath)}`,
    );
    this.name = "WorkspacePathEscapeError";
  }
}

export class DownloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Downloaded content exceeds the expected size of ${maxBytes} bytes`);
    this.name = "DownloadTooLargeError";
  }
}

export class WorkspaceTargetExistsError extends Error {
  constructor(absolutePath: string) {
    super(`Refusing to overwrite an existing local file: ${absolutePath}`);
    this.name = "WorkspaceTargetExistsError";
  }
}

// ------------------------------------------------------------
// Injected ports (download + filesystem)
// ------------------------------------------------------------

/**
 * Opens a byte stream for the EXACT `contentPath` a WorkspacePlan entry's
 * pinned version carries. Implementations decide transport/authentication;
 * this module never constructs, re-derives or re-requests any other URL.
 */
export interface ContentDownloader {
  openContentStream(contentPath: string): Promise<Readable>;
}

/** An opaque handle to bytes that have been fully received, hashed and sized
 *  but not yet placed at any final local path. */
export interface StagedDownload {
  /** Provider-internal reference (e.g. a temp file path). Never exposed to
   *  a caller as a final location. */
  ref: string;
  size: number;
  sha256: string;
}

export interface WorkspaceFsProvider {
  /** True if a filesystem entry already exists at `absolutePath`. */
  exists(absolutePath: string): Promise<boolean>;
  /** SHA-256 + byte size of an EXISTING local file, computed by streaming
   *  (never buffering the whole file). */
  hashExisting(absolutePath: string): Promise<{ sha256: string; size: number }>;
  /**
   * Stream `source` into temporary storage, measuring size and SHA-256
   * WHILE writing (never buffering the whole file in memory) and aborting
   * (with cleanup) the moment `opts.maxBytes` is exceeded. The staged bytes
   * are not yet at any final path.
   */
  stageDownload(
    source: Readable,
    opts: { maxBytes: number },
  ): Promise<StagedDownload>;
  /**
   * Atomically place staged bytes at `absolutePath`. MUST NEVER overwrite an
   * existing entry - rejects with `WorkspaceTargetExistsError` if one exists.
   */
  promote(staged: StagedDownload, absolutePath: string): Promise<void>;
  /** Best-effort removal of a staged download that was never promoted. */
  discardStaged(staged: StagedDownload): Promise<void>;
}

// ------------------------------------------------------------
// Local (Node `fs`) implementation of the filesystem port
// ------------------------------------------------------------

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EEXIST"
  );
}

/**
 * A concrete `WorkspaceFsProvider` backed by the real local filesystem.
 * Staging happens under `<root>/.arch-materialize-staging/` so promotion is
 * a same-volume, atomic, exclusive hard link (`fs.link`, which fails EEXIST
 * rather than silently overwriting) - the same immutable-object-creation
 * technique `LocalFilesystemStorage` uses server-side, re-implemented here
 * (deliberately not shared) because this is a distinct concept: an arbitrary
 * user workspace directory, not the server's authoritative object store.
 */
export class LocalWorkspaceFs implements WorkspaceFsProvider {
  readonly #root: string;

  constructor(root: string) {
    assertAbsoluteWorkspaceRoot(root);
    this.#root = pathWin32.resolve(root);
  }

  get #stagingDir(): string {
    return pathWin32.join(this.#root, ".arch-materialize-staging");
  }

  async exists(absolutePath: string): Promise<boolean> {
    try {
      await access(absolutePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async hashExisting(
    absolutePath: string,
  ): Promise<{ sha256: string; size: number }> {
    const info = await stat(absolutePath);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk as Buffer);
    }
    return { sha256: hash.digest("hex"), size: info.size };
  }

  async stageDownload(
    source: Readable,
    opts: { maxBytes: number },
  ): Promise<StagedDownload> {
    await mkdir(this.#stagingDir, { recursive: true });
    const ref = pathWin32.join(
      this.#stagingDir,
      `${randomBytes(16).toString("hex")}.part`,
    );

    const handle = await open(ref, "wx");
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        size += buf.byteLength;
        if (size > opts.maxBytes) {
          throw new DownloadTooLargeError(opts.maxBytes);
        }
        hash.update(buf);
        await handle.write(buf);
      }
      await handle.sync();
      await handle.close();
      return { ref, size, sha256: hash.digest("hex") };
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(ref, { force: true }).catch(() => {});
      source.destroy?.();
      throw error;
    }
  }

  async promote(staged: StagedDownload, absolutePath: string): Promise<void> {
    await mkdir(pathWin32.dirname(absolutePath), { recursive: true });
    try {
      await link(staged.ref, absolutePath);
    } catch (error) {
      if (isEexist(error)) {
        throw new WorkspaceTargetExistsError(absolutePath);
      }
      throw error;
    }
  }

  async discardStaged(staged: StagedDownload): Promise<void> {
    await rm(staged.ref, { force: true });
  }
}

// ------------------------------------------------------------
// Workspace-root-relative path resolution (Windows semantics)
// ------------------------------------------------------------

function assertAbsoluteWorkspaceRoot(root: string): void {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    !pathWin32.isAbsolute(root)
  ) {
    throw new WorkspaceRootError(
      `Workspace root must be an absolute path: ${JSON.stringify(root)}`,
    );
  }
}

/**
 * Resolve `relativePath` strictly underneath `root`, using Windows path
 * semantics (this is a Windows client). Defense in depth: re-validates the
 * path shape even though a `safe` WorkspacePlan already guarantees it, then
 * independently confirms the resolved absolute path is contained within the
 * root via a CASE-INSENSITIVE prefix check (NTFS is case-insensitive).
 * Rejects `..`, absolute paths, drive prefixes, backslashes, Windows-invalid
 * characters, reserved device names, and any resolution that would still
 * land outside the root.
 *
 * MILESTONE SCOPE (P3B-2B): `relativePath` must be a single flat filename -
 * no nested segments. Arch workspace plans intentionally generate flat
 * placement names today and do not yet carry real Inventor relative-
 * reference paths; until CAD Connect introduces that metadata, a nested path
 * is refused here rather than silently materializing an unbacked subfolder
 * layout (which would also open a junction / reparse-point escape surface
 * through a nested directory this module does not yet reason about). This is
 * NOT a general property of `assertSafeWorkspacePath` (which still allows
 * multi-segment paths for other, non-materialization consumers) - it is
 * enforced only here, for this milestone.
 */
export function resolveWithinWorkspaceRoot(
  root: string,
  relativePath: string,
): string {
  try {
    assertSafeWorkspacePath(relativePath);
  } catch {
    throw new WorkspacePathEscapeError(relativePath, "failed safety re-validation");
  }

  if (relativePath.includes("/")) {
    throw new WorkspacePathEscapeError(
      relativePath,
      "nested paths are not supported in this milestone - only a single " +
        "flat filename beneath the workspace root can be materialized",
    );
  }

  const resolvedRoot = pathWin32.resolve(root);
  const resolvedTarget = pathWin32.resolve(resolvedRoot, relativePath);

  const rootWithSep = resolvedRoot.endsWith(pathWin32.sep)
    ? resolvedRoot
    : resolvedRoot + pathWin32.sep;

  const targetFolded = resolvedTarget.toLowerCase();
  const rootFolded = resolvedRoot.toLowerCase();
  const rootWithSepFolded = rootWithSep.toLowerCase();

  if (targetFolded !== rootFolded && !targetFolded.startsWith(rootWithSepFolded)) {
    throw new WorkspacePathEscapeError(relativePath, "escapes the workspace root");
  }

  return resolvedTarget;
}

// ------------------------------------------------------------
// Contract support check
// ------------------------------------------------------------

const SUPPORTED_CONTRACT_MAJOR = Number(
  WORKSPACE_PLAN_CONTRACT_VERSION.split(".")[0],
);

function isSupportedContractVersion(version: string): boolean {
  const major = Number(String(version).split(".")[0]);
  return Number.isInteger(major) && major === SUPPORTED_CONTRACT_MAJOR;
}

// ------------------------------------------------------------
// Result / report shapes
// ------------------------------------------------------------

export type MaterializationStatus =
  | "downloaded"
  | "already-current"
  | "blocked"
  | "failed";

export interface MaterializationEntryResult {
  /** Authoritative identity. */
  cadDocumentId: string;
  /** Authoritative identity of the pinned version; null when the entry
   *  carried no materializable version at all. */
  fileVersionId: string | null;
  /** The (re-validated) generated relative path this entry targeted, if one
   *  could be resolved; null when blocked before any path was resolvable. */
  relativePath: string | null;
  status: MaterializationStatus;
  /** Human-readable detail for "blocked" / "failed" outcomes. */
  reason?: string;
  /** Bytes written for a fresh download; 0 for "already-current". */
  bytesWritten?: number;
  /** The (verified, matching) checksum for "downloaded" / "already-current". */
  checksum?: string;
}

export interface MaterializationReport {
  contract: { id: string; version: string };
  workspaceRoot: string;
  startedAt: string;
  finishedAt: string;
  requestedEntries: number;
  /** Deterministic, same order as `plan.entries`. */
  results: MaterializationEntryResult[];
  summary: {
    downloaded: number;
    alreadyCurrent: number;
    blocked: number;
    failed: number;
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseResult(
  entry: WorkspacePlanEntry,
): Pick<MaterializationEntryResult, "cadDocumentId" | "fileVersionId"> {
  return {
    cadDocumentId: entry.cadDocumentId,
    fileVersionId: entry.version?.fileVersionId ?? null,
  };
}

/**
 * True iff `contentPath` is EXACTLY the existing authenticated download
 * endpoint for `fileVersionId` (`/api/file-versions/<fileVersionId>/content`)
 * - never an arbitrary URL or filesystem path a hand-built/untrusted plan
 * could otherwise carry.
 */
function isExpectedContentPath(fileVersionId: string, contentPath: string): boolean {
  return (
    typeof contentPath === "string" &&
    contentPath === `/api/file-versions/${fileVersionId}/content`
  );
}

// ------------------------------------------------------------
// Per-entry materialization
// ------------------------------------------------------------

async function materializeEntry(
  entry: WorkspacePlanEntry,
  workspaceRoot: string,
  downloader: ContentDownloader,
  fs: WorkspaceFsProvider,
): Promise<MaterializationEntryResult> {
  const base = baseResult(entry);

  // Defense in depth: re-check materializability even though `plan.safe`
  // already gated the whole operation. A future contract or a bug elsewhere
  // must never cause a doomed download attempt or a crash here.
  if (!entry.canMaterialize || !entry.version) {
    return {
      ...base,
      relativePath: null,
      status: "blocked",
      reason:
        entry.blockedReasons.length > 0
          ? `Entry cannot be materialized: ${entry.blockedReasons.join(", ")}`
          : "Entry has no materializable version",
    };
  }

  const version = entry.version;

  // Defense in depth: a pinned version's contentPath must be EXACTLY the
  // authenticated download endpoint for its own fileVersionId - never an
  // arbitrary URL/path a hand-built or otherwise untrusted plan could carry.
  // This never attempts a download for an entry that fails this check.
  if (!isExpectedContentPath(version.fileVersionId, version.contentPath)) {
    return {
      ...base,
      relativePath: null,
      status: "blocked",
      reason:
        "Refusing an untrusted contentPath: expected the authenticated " +
        `/api/file-versions/${version.fileVersionId}/content endpoint, got ` +
        JSON.stringify(version.contentPath),
    };
  }

  let absolutePath: string;
  try {
    absolutePath = resolveWithinWorkspaceRoot(
      workspaceRoot,
      entry.placement.generatedRelativePath,
    );
  } catch (error) {
    return {
      ...base,
      relativePath: entry.placement.generatedRelativePath,
      status: "blocked",
      reason: message(error),
    };
  }

  const relativePath = entry.placement.generatedRelativePath;

  // Existing-file behavior (no checkout semantics yet): same checksum ->
  // already-current (no download); different checksum -> never overwritten.
  if (await fs.exists(absolutePath)) {
    let existing: { sha256: string; size: number };
    try {
      existing = await fs.hashExisting(absolutePath);
    } catch (error) {
      return {
        ...base,
        relativePath,
        status: "failed",
        reason: `Could not inspect the existing local file: ${message(error)}`,
      };
    }

    if (
      existing.sha256 === version.checksum &&
      existing.size === version.fileSize
    ) {
      return {
        ...base,
        relativePath,
        status: "already-current",
        checksum: existing.sha256,
        bytesWritten: 0,
      };
    }

    return {
      ...base,
      relativePath,
      status: "blocked",
      reason:
        "local-conflict: an existing file at this path differs from the " +
        "pinned FileVersion and was not overwritten",
    };
  }

  // Download to a temp file, streaming - size and SHA-256 are computed while
  // writing, never after buffering the whole file.
  let staged: StagedDownload;
  try {
    const source = await downloader.openContentStream(version.contentPath);
    staged = await fs.stageDownload(source, { maxBytes: version.fileSize });
  } catch (error) {
    return {
      ...base,
      relativePath,
      status: "failed",
      reason: `Download failed: ${message(error)}`,
    };
  }

  // Verify BOTH byte size and SHA-256 before any promotion is attempted.
  if (staged.size !== version.fileSize || staged.sha256 !== version.checksum) {
    await fs.discardStaged(staged).catch(() => {});
    return {
      ...base,
      relativePath,
      status: "failed",
      reason:
        `Integrity check failed: expected ${version.fileSize} bytes / ` +
        `${version.checksum}, got ${staged.size} bytes / ${staged.sha256}`,
    };
  }

  try {
    await fs.promote(staged, absolutePath);
    return {
      ...base,
      relativePath,
      status: "downloaded",
      checksum: staged.sha256,
      bytesWritten: staged.size,
    };
  } catch (error) {
    if (error instanceof WorkspaceTargetExistsError) {
      // Rare race: something created the target between our exists() check
      // and promotion. Never overwrite - report as a conflict, not a crash.
      return {
        ...base,
        relativePath,
        status: "blocked",
        reason:
          "local-conflict: a file appeared at this path during " +
          "materialization and was not overwritten",
      };
    }
    return {
      ...base,
      relativePath,
      status: "failed",
      reason: `Could not place the downloaded file: ${message(error)}`,
    };
  } finally {
    // The staged inode is either now also linked at the final path (success)
    // or no longer wanted (failure); dropping the staging name is always safe.
    await fs.discardStaged(staged).catch(() => {});
  }
}

// ------------------------------------------------------------
// Whole-plan orchestration
// ------------------------------------------------------------

export interface MaterializeWorkspacePlanDeps {
  downloader: ContentDownloader;
  fs: WorkspaceFsProvider;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/**
 * Materialize an already-generated, tenant-safe `WorkspacePlan` onto the
 * local filesystem underneath `workspaceRoot`.
 *
 * Refuses the ENTIRE operation (throws, nothing is downloaded or written)
 * when:
 *   - `plan.contract.id` is not the id this module supports, or
 *   - `plan.contract.version`'s major component is not supported, or
 *   - `plan.safe !== true`.
 *
 * Otherwise processes every entry independently and deterministically (same
 * order as `plan.entries`), producing a report with a per-entry status of
 * "downloaded", "already-current", "blocked" or "failed". A problem with one
 * entry never aborts the others.
 *
 * Before any entry is attempted, entries whose (re-validated) placement path
 * collides - case-insensitively, matching NTFS - with another entry's path
 * are independently detected here too (defense in depth: a `safe` plan
 * should never contain such a collision) and are blocked rather than risking
 * two different documents racing to write the same local file.
 */
export async function materializeWorkspacePlan(
  plan: WorkspacePlan,
  workspaceRoot: string,
  deps: MaterializeWorkspacePlanDeps,
): Promise<MaterializationReport> {
  assertAbsoluteWorkspaceRoot(workspaceRoot);

  if (plan.contract.id !== WORKSPACE_PLAN_CONTRACT_ID) {
    throw new UnsupportedWorkspaceContractError(
      `Unsupported workspace contract id: ${JSON.stringify(plan.contract.id)}`,
    );
  }
  if (!isSupportedContractVersion(plan.contract.version)) {
    throw new UnsupportedWorkspaceContractError(
      `Unsupported workspace contract version: ${JSON.stringify(plan.contract.version)} ` +
        `(this client supports major version ${SUPPORTED_CONTRACT_MAJOR})`,
    );
  }
  if (plan.safe !== true) {
    throw new UnsafeWorkspacePlanError();
  }

  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();

  // Defense-in-depth local collision pre-pass (see doc comment above).
  const foldedPathOwners = new Map<string, string[]>();
  const preResolved = new Map<string, string>();
  for (const entry of plan.entries) {
    if (!entry.canMaterialize) continue;
    try {
      const absolutePath = resolveWithinWorkspaceRoot(
        workspaceRoot,
        entry.placement.generatedRelativePath,
      );
      preResolved.set(entry.cadDocumentId, absolutePath);
      const key = absolutePath.toLowerCase();
      const owners = foldedPathOwners.get(key) ?? [];
      owners.push(entry.cadDocumentId);
      foldedPathOwners.set(key, owners);
    } catch {
      // Handled again (and reported) inside materializeEntry.
    }
  }
  const collidingDocIds = new Set<string>();
  for (const owners of foldedPathOwners.values()) {
    if (owners.length > 1) {
      for (const id of owners) collidingDocIds.add(id);
    }
  }

  const results: MaterializationEntryResult[] = [];
  for (const entry of plan.entries) {
    if (collidingDocIds.has(entry.cadDocumentId)) {
      results.push({
        ...baseResult(entry),
        relativePath: entry.placement.generatedRelativePath,
        status: "blocked",
        reason:
          "local-path-collision: another entry in this plan resolves to " +
          "the same local path (case-insensitive)",
      });
      continue;
    }
    results.push(
      await materializeEntry(entry, workspaceRoot, deps.downloader, deps.fs),
    );
  }

  const finishedAt = now().toISOString();
  const summary = {
    downloaded: results.filter((r) => r.status === "downloaded").length,
    alreadyCurrent: results.filter((r) => r.status === "already-current").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    failed: results.filter((r) => r.status === "failed").length,
  };

  return {
    contract: plan.contract,
    workspaceRoot: pathWin32.resolve(workspaceRoot),
    startedAt,
    finishedAt,
    requestedEntries: plan.entries.length,
    results,
    summary,
  };
}
