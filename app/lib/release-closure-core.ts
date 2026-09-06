/**
 * Arch PDM - dependency-complete release closure (P3D-3, provider-agnostic
 * core).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Given a revision's DIRECT root CadDocuments (from
 * ItemRevisionDocument) it walks the authoritative outgoing CadDependency
 * graph - `parentDocumentId -> childDocumentId`, recursively - and returns
 * the exact, deduplicated, deterministically ordered set of CadDocument IDs
 * that a ReleaseBaseline must freeze, each tagged DIRECT or DEPENDENCY.
 *
 * SCOPE: only the CadDependency edges currently stored in PLM are in scope.
 * Dependencies are NEVER inferred from filenames, storage paths, Inventor
 * file contents, or workspace layout - this module is handed edges and roots
 * and does graph math, nothing else.
 *
 * PROVENANCE: a root is DIRECT. A document reached only through the closure
 * is DEPENDENCY. A document that is BOTH a direct root and reachable as a
 * dependency is DIRECT (roots are seeded first and never downgraded), and it
 * still appears exactly once.
 *
 * CYCLE SAFETY: a `visited` set means every document is expanded at most
 * once, so a pre-existing malformed cycle (A -> B -> A) terminates and is
 * simply absorbed. Application rules prevent cycles today; this does not
 * assume that.
 *
 * BOUNDED: a hard `maxNodes` cap (default aligned with Get Latest's
 * `DEFAULT_MAX_PACKAGE_NODES`) makes an adversarial or corrupt graph fail
 * fast rather than doing unbounded work. Exceeding it aborts the release -
 * a silently truncated release package would be worse than no release.
 *
 * DETERMINISM: every frontier and every batch of newly discovered ids is
 * sorted before use, and the result is sorted by cadDocumentId, so the same
 * graph + same roots always produce the same closure regardless of database
 * row-return order.
 */

/** Kept in lockstep with `get-latest-core.ts`'s `DEFAULT_MAX_PACKAGE_NODES`
 *  so a graph that is releasable is also packageable and vice versa. */
export const DEFAULT_MAX_RELEASE_CLOSURE_NODES = 5000;

/** Safety bound on how many lock/re-scan passes the wiring layer may take to
 *  reach a stable locked closure (see `release-db.ts`). A graph that will
 *  not converge within this many passes is treated as adversarial. */
export const MAX_CLOSURE_STABILIZATION_PASSES = 64;

export type ReleaseInclusionKind = "DIRECT" | "DEPENDENCY";

export class ReleaseClosureTooLargeError extends Error {
  readonly maxNodes: number;
  constructor(maxNodes: number) {
    super(
      `The CAD dependency closure for this release exceeds ${maxNodes} ` +
        "documents and cannot be frozen safely. Please contact an administrator.",
    );
    this.name = "ReleaseClosureTooLargeError";
    this.maxNodes = maxNodes;
  }
}

/** A discovered dependency child that does not resolve to a real CadDocument
 *  in the same organization. The CadDependency composite FK makes this
 *  practically impossible, so if it is ever observed the release aborts
 *  rather than freezing an incomplete closure or leaking a foreign id. */
export class ReleaseClosureInvalidError extends Error {
  readonly cadDocumentId: string;
  readonly reason: "dangling-dependency";
  constructor(cadDocumentId: string, reason: "dangling-dependency" = "dangling-dependency") {
    super(
      `A CAD dependency in this release's closure points at document ` +
        `${cadDocumentId}, which is not available in your organization.`,
    );
    this.name = "ReleaseClosureInvalidError";
    this.cadDocumentId = cadDocumentId;
    this.reason = reason;
  }
}

export interface ReleaseClosureEdge {
  parentCadDocumentId: string;
  childCadDocumentId: string;
}

export interface ReleaseClosureDeps {
  maxNodes?: number;
  /** DIRECT root CadDocument IDs (from ItemRevisionDocument), tenant-scoped.
   *  May contain duplicates; this module deduplicates. */
  loadDirectDocumentIds(): Promise<string[]>;
  /** Every outgoing `parent -> child` edge whose parent is in `parentIds`.
   *  Tenant-scoped. Order irrelevant (this module sorts). */
  loadChildEdges(parentIds: string[]): Promise<ReleaseClosureEdge[]>;
  /** The subset of `ids` that exist as CadDocuments in the tenant. */
  loadExistingDocumentIds(ids: string[]): Promise<string[]>;
}

export interface ReleaseClosureNode {
  cadDocumentId: string;
  inclusionKind: ReleaseInclusionKind;
}

export interface ReleaseClosureResult {
  /** Deterministic: cadDocumentId ascending. */
  nodes: ReleaseClosureNode[];
  /** The same ids, ascending - the exact set the wiring layer must lock. */
  cadDocumentIds: string[];
  directCount: number;
  dependencyCount: number;
  /** Distinct non-self parent->child edges observed within the closure. */
  edgeCount: number;
}

/**
 * Compute the dependency-complete release closure. See the module doc
 * comment for the exact semantics.
 *
 * @throws ReleaseClosureTooLargeError if the closure would exceed `maxNodes`.
 * @throws ReleaseClosureInvalidError if a discovered dependency child is not
 *   a real CadDocument in the tenant.
 */
export async function computeReleaseClosure(
  deps: ReleaseClosureDeps,
): Promise<ReleaseClosureResult> {
  const maxNodes = deps.maxNodes ?? DEFAULT_MAX_RELEASE_CLOSURE_NODES;

  const rootIds = [...new Set(await deps.loadDirectDocumentIds())];
  if (rootIds.length > maxNodes) {
    throw new ReleaseClosureTooLargeError(maxNodes);
  }

  // DIRECT is seeded first and never overwritten, so a document that is both
  // a root and a dependency child stays DIRECT.
  const provenance = new Map<string, ReleaseInclusionKind>();
  for (const id of rootIds) {
    provenance.set(id, "DIRECT");
  }

  const visited = new Set<string>(rootIds);
  const seenEdge = new Set<string>();
  let edgeCount = 0;
  let frontier = [...rootIds].sort();

  while (frontier.length > 0) {
    const edges = await deps.loadChildEdges(frontier);

    const discovered = new Set<string>();
    for (const edge of edges) {
      if (edge.parentCadDocumentId === edge.childCadDocumentId) {
        // Malformed self-reference: never traversed, never counted.
        continue;
      }
      const key = `${edge.parentCadDocumentId}::${edge.childCadDocumentId}`;
      if (!seenEdge.has(key)) {
        seenEdge.add(key);
        edgeCount += 1;
      }
      if (!visited.has(edge.childCadDocumentId)) {
        discovered.add(edge.childCadDocumentId);
      }
    }

    if (discovered.size === 0) {
      break;
    }

    if (visited.size + discovered.size > maxNodes) {
      throw new ReleaseClosureTooLargeError(maxNodes);
    }

    const discoveredIds = [...discovered].sort();
    const existing = new Set(await deps.loadExistingDocumentIds(discoveredIds));
    for (const id of discoveredIds) {
      if (!existing.has(id)) {
        throw new ReleaseClosureInvalidError(id);
      }
      visited.add(id);
      if (!provenance.has(id)) {
        provenance.set(id, "DEPENDENCY");
      }
    }

    frontier = discoveredIds;
  }

  const nodes: ReleaseClosureNode[] = [...provenance.entries()]
    .map(([cadDocumentId, inclusionKind]) => ({ cadDocumentId, inclusionKind }))
    .sort((a, b) => a.cadDocumentId.localeCompare(b.cadDocumentId));

  return {
    nodes,
    cadDocumentIds: nodes.map((n) => n.cadDocumentId),
    directCount: nodes.filter((n) => n.inclusionKind === "DIRECT").length,
    dependencyCount: nodes.filter((n) => n.inclusionKind === "DEPENDENCY").length,
    edgeCount,
  };
}
