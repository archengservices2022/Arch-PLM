/**
 * Arch PDM - "Get Latest" package manifest (provider-agnostic core).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type system
 * and a couple of `RegExp`s. It walks a CAD dependency graph from a root
 * document, resolves every reachable document to its latest binary-backed
 * FileVersion, and assembles a deterministic, path-safe manifest.
 *
 * The database + tenant wiring lives in `app/lib/get-latest.ts`; every lookup
 * it injects here is already scoped to the authenticated actor's organization.
 *
 * Scope (P3B-1): this produces a MANIFEST only. It does not create a workspace
 * on disk, does not generate a ZIP, and does not read or write ItemRevision /
 * lifecycle state. "Get Latest" tracks the live latest FileVersion of each
 * document; it is deliberately NOT an engineering release baseline.
 */

// Control characters: NUL..US (0x00-0x1F) plus DEL (0x7F). Built from a string
// so the source file stays pure ASCII (matching app/lib/storage-core.ts).
const CONTROL_CHAR_CLASS = "[\u0000-\u001F\u007F]";
const HAS_CONTROL_CHAR = new RegExp(CONTROL_CHAR_CLASS);
const ALL_CONTROL_CHARS = new RegExp(CONTROL_CHAR_CLASS, "g");

/** Same rule as a storage-key segment: start alphanumeric, then
 *  alphanumeric / dot / underscore / hyphen. No spaces, no traversal. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISALLOWED_PATH_CHARS = /[^A-Za-z0-9._-]+/g;

// ------------------------------------------------------------
// Limits (keep traversal bounded and deterministic)
// ------------------------------------------------------------

export const DEFAULT_MAX_PACKAGE_NODES = 5000;
export const DEFAULT_MAX_VERSIONS_SCANNED = 500;

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class RootCadDocumentNotFoundError extends Error {
  constructor() {
    super("CAD document not found in your organization");
    this.name = "RootCadDocumentNotFoundError";
  }
}

export class CadGraphTooLargeError extends Error {
  constructor(maxNodes: number) {
    super(
      `The CAD dependency graph exceeds ${maxNodes} documents and cannot be ` +
        "packaged safely. Please contact an administrator.",
    );
    this.name = "CadGraphTooLargeError";
  }
}

export class UnsafeWorkspacePathError extends Error {
  constructor(value: string, reason: string) {
    super(`Unsafe workspace path (${reason}): ${JSON.stringify(value)}`);
    this.name = "UnsafeWorkspacePathError";
  }
}

// ------------------------------------------------------------
// Injected data shapes (already tenant-scoped by the caller)
// ------------------------------------------------------------

export interface ManifestDocumentRow {
  id: string;
  documentNumber: string;
  fileName: string;
  /** CadDocumentType as a plain string (IPT, IAM, ...). */
  cadType: string;
}

export interface ManifestDependencyEdge {
  parentDocumentId: string;
  childDocumentId: string;
  /** CadDependencyType as a plain string (COMPONENT, ...). */
  dependencyType: string;
}

export interface ManifestVersionRow {
  id: string;
  versionNumber: number;
  checksum: string | null;
  /** Byte size; the wiring layer converts Prisma's BigInt to a number. */
  fileSize: number | null;
  originalFileName: string;
  storageKey: string;
}

export interface GetLatestDeps {
  /** Hard cap on reachable documents. Exceeding it throws
   *  CadGraphTooLargeError (a silently truncated package is unsafe). */
  maxNodes?: number;
  /** Cap on how many versions per document are scanned newest-first. */
  maxVersionsScanned?: number;
  /** Clock injection for deterministic tests. */
  now?: () => Date;

  /** Tenant-scoped. Returns only the documents (from `ids`) that exist in the
   *  caller's organization - anything missing is treated as a dangling edge. */
  loadDocuments(ids: string[]): Promise<ManifestDocumentRow[]>;

  /** Tenant-scoped. Every parent -> child edge whose parent is in
   *  `parentDocumentIds`. */
  loadChildEdges(
    parentDocumentIds: string[],
  ): Promise<ManifestDependencyEdge[]>;

  /** Tenant-scoped. Versions for one document, ordered newest versionNumber
   *  first (already capped by the wiring layer). */
  loadVersionsNewestFirst(cadDocumentId: string): Promise<ManifestVersionRow[]>;

  /** True when the stored binary object for `storageKey` actually exists. */
  objectExists(storageKey: string): Promise<boolean>;
}

// ------------------------------------------------------------
// Manifest output
// ------------------------------------------------------------

export type ManifestProblemKind =
  | "missing-version"
  | "missing-binary"
  | "dangling-dependency"
  | "path-collision";

export interface ManifestProblem {
  kind: ManifestProblemKind;
  message: string;
  /** The document this problem is primarily about (if any). */
  cadDocumentId?: string;
  /** All documents involved (path collisions, dangling edges). */
  cadDocumentIds?: string[];
  /** The colliding relative path, for `path-collision`. */
  workspacePath?: string;
}

export interface ManifestVersion {
  fileVersionId: string;
  versionNumber: number;
  checksum: string;
  fileSize: number;
  originalFileName: string;
  /**
   * Relative URL of the EXISTING authenticated, tenant-scoped download
   * endpoint. Get Latest does not stream or bundle bytes itself.
   */
  contentPath: string;
}

export interface ManifestEntry {
  cadDocumentId: string;
  documentNumber: string;
  fileName: string;
  cadType: string;
  isRoot: boolean;
  /** Safe, relative, POSIX-style path for a future local workspace. */
  workspacePath: string;
  /** Outgoing edges to other documents IN this package (deduplicated,
   *  deterministically ordered). */
  dependsOn: Array<{ cadDocumentId: string; dependencyType: string }>;
  /** The resolved latest binary-backed version, or null when unavailable. */
  version: ManifestVersion | null;
  /** Problem kinds affecting this entry (empty when the entry is clean). */
  problems: ManifestProblemKind[];
}

export interface GetLatestManifest {
  root: { cadDocumentId: string };
  generatedAt: string;
  documentCount: number;
  /** True iff `problems` is empty: every required document resolved to a
   *  stored binary version and there are no path collisions or dangling
   *  edges. */
  complete: boolean;
  entries: ManifestEntry[];
  problems: ManifestProblem[];
  traversal: {
    visitedCount: number;
    edgeCount: number;
    maxNodes: number;
  };
}

// ------------------------------------------------------------
// Workspace path derivation (safe, relative, deterministic)
// ------------------------------------------------------------

/**
 * Throws unless `value` is a safe relative POSIX-style path: no backslash, no
 * control chars, no absolute / home / drive prefix, no `.` or `..` segments,
 * every segment matching SAFE_PATH_SEGMENT.
 */
export function assertSafeWorkspacePath(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnsafeWorkspacePathError(String(value), "empty");
  }
  if (value.length > 512) {
    throw new UnsafeWorkspacePathError(value, "too long");
  }
  if (value.includes("\\")) {
    throw new UnsafeWorkspacePathError(value, "backslash");
  }
  if (HAS_CONTROL_CHAR.test(value)) {
    throw new UnsafeWorkspacePathError(value, "control character");
  }
  if (value.startsWith("/") || value.startsWith("~")) {
    throw new UnsafeWorkspacePathError(value, "absolute / home");
  }
  if (/^[A-Za-z]:/.test(value)) {
    throw new UnsafeWorkspacePathError(value, "drive prefix");
  }
  for (const segment of value.split("/")) {
    if (segment.length === 0) {
      throw new UnsafeWorkspacePathError(value, "empty segment");
    }
    if (segment === "." || segment === "..") {
      throw new UnsafeWorkspacePathError(value, "dot segment");
    }
    if (!SAFE_PATH_SEGMENT.test(segment)) {
      throw new UnsafeWorkspacePathError(
        value,
        `bad segment ${JSON.stringify(segment)}`,
      );
    }
  }
}

/**
 * Derive a safe, flat, deterministic workspace path from a CAD document's
 * stored filename. The client-supplied filename is NEVER trusted: only its
 * last path segment is kept, control chars and disallowed characters are
 * replaced, leading dots / underscores are stripped. When nothing usable
 * remains, `documentNumber` (then a constant) is the deterministic fallback.
 *
 * P3B-1 uses a flat layout, so two documents whose filenames normalize to the
 * same path collide - that collision is reported, never auto-resolved.
 */
export function workspaceRelativePath(
  fileName: string,
  documentNumber: string,
): string {
  const candidates = [fileName, documentNumber, "document"];

  for (const raw of candidates) {
    const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
    const cleaned = base
      .replace(ALL_CONTROL_CHARS, "")
      .replace(DISALLOWED_PATH_CHARS, "_")
      .replace(/_+/g, "_")
      .replace(/^[._]+/, "")
      .replace(/\.+$/, "")
      .slice(0, 200);
    if (cleaned.length > 0 && SAFE_PATH_SEGMENT.test(cleaned)) {
      assertSafeWorkspacePath(cleaned);
      return cleaned;
    }
  }

  // Unreachable: "document" always satisfies SAFE_PATH_SEGMENT.
  return "document";
}

// ------------------------------------------------------------
// Version resolution
// ------------------------------------------------------------

type VersionResolution =
  | { kind: "ok"; row: ManifestVersionRow }
  | { kind: "missing-version" }
  | { kind: "missing-binary"; row: ManifestVersionRow };

/** A version row is a real, immutable binary version iff it carries a
 *  server-computed checksum and byte size (the metadata-only creation path
 *  that produced neither was removed in P3A-1). */
function isBinaryBacked(row: ManifestVersionRow): boolean {
  return (
    typeof row.checksum === "string" &&
    row.checksum.length > 0 &&
    typeof row.fileSize === "number" &&
    Number.isFinite(row.fileSize) &&
    row.fileSize >= 0
  );
}

async function resolveLatestVersion(
  cadDocumentId: string,
  deps: GetLatestDeps,
): Promise<VersionResolution> {
  const maxScan = deps.maxVersionsScanned ?? DEFAULT_MAX_VERSIONS_SCANNED;
  const rows = (await deps.loadVersionsNewestFirst(cadDocumentId)).slice(
    0,
    maxScan,
  );

  // Newest-first: the first metadata-complete row is "the latest version".
  const latest = rows.find(isBinaryBacked);
  if (!latest) {
    return { kind: "missing-version" };
  }

  // The latest version must have its bytes in storage. We deliberately do NOT
  // fall back to an older version: the document's current state would be
  // misrepresented by shipping stale bytes as "latest".
  const exists = await deps.objectExists(latest.storageKey);
  return exists ? { kind: "ok", row: latest } : { kind: "missing-binary", row: latest };
}

// ------------------------------------------------------------
// Graph traversal
// ------------------------------------------------------------

interface TraversalResult {
  documents: Map<string, ManifestDocumentRow>;
  /** Deduplicated edges (parent -> child -> type). */
  edges: ManifestDependencyEdge[];
  /** Child ids referenced by an edge but absent from the tenant. */
  danglingChildIds: Set<string>;
  visitedCount: number;
}

function edgeKey(edge: ManifestDependencyEdge): string {
  // "::" never appears in a cuid id or an enum name.
  return [edge.parentDocumentId, edge.childDocumentId, edge.dependencyType].join("::");
}

/**
 * Breadth-first walk of parent -> child edges from the root.
 *
 * Cycle / malformed-graph safety: a `visited` set means every document is
 * expanded at most once, so a pre-existing cycle (A -> B -> A) terminates and
 * is simply recorded as edges. A hard `maxNodes` cap bounds the work.
 * Each BFS level sorts its frontier and its newly discovered ids, so the
 * result is independent of database row order.
 */
async function traverse(
  rootDocumentId: string,
  root: ManifestDocumentRow,
  deps: GetLatestDeps,
): Promise<TraversalResult> {
  const maxNodes = deps.maxNodes ?? DEFAULT_MAX_PACKAGE_NODES;

  const documents = new Map<string, ManifestDocumentRow>([
    [rootDocumentId, root],
  ]);
  const edges: ManifestDependencyEdge[] = [];
  const seenEdge = new Set<string>();
  const danglingChildIds = new Set<string>();

  const visited = new Set<string>([rootDocumentId]);
  let frontier: string[] = [rootDocumentId];

  while (frontier.length > 0) {
    const childEdges = await deps.loadChildEdges([...frontier].sort());

    const discovered = new Set<string>();
    for (const edge of childEdges) {
      const key = edgeKey(edge);
      if (!seenEdge.has(key)) {
        seenEdge.add(key);
        edges.push(edge);
      }
      if (
        edge.childDocumentId !== edge.parentDocumentId &&
        !visited.has(edge.childDocumentId)
      ) {
        discovered.add(edge.childDocumentId);
      }
    }

    if (discovered.size === 0) {
      break;
    }

    if (visited.size + discovered.size > maxNodes) {
      throw new CadGraphTooLargeError(maxNodes);
    }

    const discoveredIds = [...discovered].sort();
    const loaded = await deps.loadDocuments(discoveredIds);
    const loadedById = new Map<string, ManifestDocumentRow>(
      loaded.map((doc) => [doc.id, doc] as [string, ManifestDocumentRow]),
    );

    const nextFrontier: string[] = [];
    for (const id of discoveredIds) {
      visited.add(id);
      const doc = loadedById.get(id);
      if (doc) {
        documents.set(id, doc);
        nextFrontier.push(id);
      } else {
        // Edge points at a document that is not in this organization (or no
        // longer exists). Composite FKs make this rare, but never leak it and
        // never traverse into it.
        danglingChildIds.add(id);
      }
    }

    frontier = nextFrontier;
  }

  return {
    documents,
    edges,
    danglingChildIds,
    visitedCount: visited.size,
  };
}

// ------------------------------------------------------------
// Manifest assembly
// ------------------------------------------------------------

/**
 * Build the Get Latest manifest for `rootCadDocumentId`.
 *
 * Steps:
 *   1. confirm the root document exists in the tenant (else throw);
 *   2. BFS the dependency graph (deduplicated, cycle-safe, node-capped);
 *   3. resolve each document to its latest binary-backed FileVersion;
 *   4. derive a safe relative workspace path per document;
 *   5. detect path collisions and dangling edges;
 *   6. emit a deterministic manifest - root first, then by documentNumber.
 *
 * `complete` is true only when there are zero problems.
 */
export async function buildGetLatestManifest(
  rootCadDocumentId: string,
  deps: GetLatestDeps,
): Promise<GetLatestManifest> {
  const maxNodes = deps.maxNodes ?? DEFAULT_MAX_PACKAGE_NODES;
  const now = deps.now ?? (() => new Date());

  const [root] = await deps.loadDocuments([rootCadDocumentId]);
  if (!root || root.id !== rootCadDocumentId) {
    throw new RootCadDocumentNotFoundError();
  }

  const { documents, edges, danglingChildIds, visitedCount } = await traverse(
    rootCadDocumentId,
    root,
    deps,
  );

  const inPackage = (id: string): boolean => documents.has(id);

  // Outgoing edges per parent, restricted to in-package children, deduped and
  // deterministically ordered.
  const dependsOnByParent = new Map<
    string,
    Array<{ cadDocumentId: string; dependencyType: string }>
  >();
  for (const edge of edges) {
    if (edge.parentDocumentId === edge.childDocumentId) {
      // Malformed self-reference: never traversed, never a dependency edge.
      continue;
    }
    if (!inPackage(edge.parentDocumentId) || !inPackage(edge.childDocumentId)) {
      continue;
    }
    const list = dependsOnByParent.get(edge.parentDocumentId) ?? [];
    list.push({
      cadDocumentId: edge.childDocumentId,
      dependencyType: edge.dependencyType,
    });
    dependsOnByParent.set(edge.parentDocumentId, list);
  }
  for (const list of dependsOnByParent.values()) {
    list.sort(
      (a, b) =>
        a.cadDocumentId.localeCompare(b.cadDocumentId) ||
        a.dependencyType.localeCompare(b.dependencyType),
    );
  }

  // Deterministic entry order: root first, then by documentNumber, then id.
  const orderedDocs = [...documents.values()].sort((a, b) => {
    if (a.id === rootCadDocumentId) return -1;
    if (b.id === rootCadDocumentId) return 1;
    return (
      a.documentNumber.localeCompare(b.documentNumber) ||
      a.id.localeCompare(b.id)
    );
  });

  const problems: ManifestProblem[] = [];
  const entries: ManifestEntry[] = [];
  const problemKindsByDoc = new Map<string, Set<ManifestProblemKind>>();

  const addProblemKind = (docId: string, kind: ManifestProblemKind): void => {
    const set = problemKindsByDoc.get(docId) ?? new Set<ManifestProblemKind>();
    set.add(kind);
    problemKindsByDoc.set(docId, set);
  };

  // 1. Version resolution (once per document) + path derivation.
  const resolvedPathByDoc = new Map<string, string>();
  const resolutionByDoc = new Map<string, VersionResolution>();
  for (const doc of orderedDocs) {
    const workspacePath = workspaceRelativePath(doc.fileName, doc.documentNumber);
    resolvedPathByDoc.set(doc.id, workspacePath);

    const resolution = await resolveLatestVersion(doc.id, deps);
    resolutionByDoc.set(doc.id, resolution);
    if (resolution.kind === "missing-version") {
      addProblemKind(doc.id, "missing-version");
      problems.push({
        kind: "missing-version",
        cadDocumentId: doc.id,
        message: `No stored binary file version exists for ${doc.documentNumber}.`,
      });
    } else if (resolution.kind === "missing-binary") {
      addProblemKind(doc.id, "missing-binary");
      problems.push({
        kind: "missing-binary",
        cadDocumentId: doc.id,
        message: `The latest file version (V${resolution.row.versionNumber}) of ${doc.documentNumber} has no stored binary.`,
      });
    }
  }

  // 2. Path collisions between DIFFERENT documents (case-insensitive).
  const docsByPathKey = new Map<string, string[]>();
  for (const doc of orderedDocs) {
    const key = (resolvedPathByDoc.get(doc.id) ?? "").toLowerCase();
    const list = docsByPathKey.get(key) ?? [];
    list.push(doc.id);
    docsByPathKey.set(key, list);
  }
  for (const [, ids] of [...docsByPathKey.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (ids.length < 2) continue;
    const sortedIds = [...ids].sort();
    for (const id of sortedIds) {
      addProblemKind(id, "path-collision");
    }
    problems.push({
      kind: "path-collision",
      cadDocumentIds: sortedIds,
      workspacePath: resolvedPathByDoc.get(sortedIds[0]) ?? "",
      message:
        `Multiple CAD documents resolve to the same workspace path ` +
        `${JSON.stringify(resolvedPathByDoc.get(sortedIds[0]) ?? "")}. ` +
        "Resolve the filename conflict; files are never auto-renamed.",
    });
  }

  // 3. Dangling edges (child referenced but not available in the tenant).
  const danglingParents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!danglingChildIds.has(edge.childDocumentId)) continue;
    if (!inPackage(edge.parentDocumentId)) continue;
    const set = danglingParents.get(edge.parentDocumentId) ?? new Set<string>();
    set.add(edge.childDocumentId);
    danglingParents.set(edge.parentDocumentId, set);
    addProblemKind(edge.parentDocumentId, "dangling-dependency");
  }
  for (const parentId of [...danglingParents.keys()].sort()) {
    const children = [...(danglingParents.get(parentId) ?? [])].sort();
    problems.push({
      kind: "dangling-dependency",
      cadDocumentId: parentId,
      cadDocumentIds: children,
      message:
        `${parentId} depends on ${children.length} CAD document(s) that are ` +
        "not available in your organization.",
    });
  }

  // 4. Build entries in deterministic order.
  for (const doc of orderedDocs) {
    const resolution =
      resolutionByDoc.get(doc.id) ?? ({ kind: "missing-version" } as const);
    const workspacePath = resolvedPathByDoc.get(doc.id) ?? "document";

    let version: ManifestVersion | null = null;
    if (resolution.kind === "ok") {
      version = {
        fileVersionId: resolution.row.id,
        versionNumber: resolution.row.versionNumber,
        checksum: resolution.row.checksum as string,
        fileSize: resolution.row.fileSize as number,
        originalFileName: resolution.row.originalFileName,
        contentPath: `/api/file-versions/${resolution.row.id}/content`,
      };
    }

    const kinds = [...(problemKindsByDoc.get(doc.id) ?? [])].sort();

    entries.push({
      cadDocumentId: doc.id,
      documentNumber: doc.documentNumber,
      fileName: doc.fileName,
      cadType: doc.cadType,
      isRoot: doc.id === rootCadDocumentId,
      workspacePath,
      dependsOn: dependsOnByParent.get(doc.id) ?? [],
      version,
      problems: kinds,
    });
  }

  // Stable problem ordering.
  problems.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.cadDocumentId ?? "").localeCompare(b.cadDocumentId ?? "") ||
      (a.workspacePath ?? "").localeCompare(b.workspacePath ?? ""),
  );

  if (visitedCount > maxNodes) {
    // Defensive: traverse() should have thrown already.
    throw new CadGraphTooLargeError(maxNodes);
  }

  return {
    root: { cadDocumentId: rootCadDocumentId },
    generatedAt: now().toISOString(),
    documentCount: entries.length,
    complete: problems.length === 0,
    entries,
    problems,
    traversal: {
      visitedCount,
      edgeCount: edges.length,
      maxNodes,
    },
  };
}
