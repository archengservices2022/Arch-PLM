/**
 * Arch PDM - B06 assembly release guard (pilot rule D-B = BOM-1(a)).
 *
 * Pure module: no `@/` imports, no Prisma, no framework. The wiring lives in
 * `app/lib/release-db.ts` (`buildReleaseBaselineInTransaction`), which calls
 * `findStructureGaps` on the release closure AFTER the closure is locked and
 * BEFORE any file version is resolved or hashed.
 *
 * RULE (backlog B06, MA-9 "the server can release ... an assembly without its
 * parts"): every document in the release closure - directly linked or reached
 * through dependencies, so nested sub-assemblies are included - must have
 * SOME recorded structure:
 *   - an assembly (IAM) needs at least one outgoing COMPONENT link;
 *   - a drawing (IDW / DWG) needs at least one outgoing DRAWING_REFERENCE link.
 * Links of other types (REFERENCE, DERIVED, OTHER) do not satisfy the rule.
 * IPT, PDF and OTHER documents have no requirement.
 *
 * LIMITS (stated in the PO-signed BOM decision sheet and the B06 plan): the
 * guard detects only MISSING structure. It cannot tell whether a recorded
 * structure is complete or up to date (check-in does not record links yet,
 * MU-F2), and it has no rule that an assembly needs a drawing - a drawing is
 * in a release only if it is linked to the revision. Completeness relies on
 * the written structure procedure (docs/pilot-structure-procedure.md).
 */

export const STRUCTURE_GAP_KINDS = ["ASSEMBLY_WITHOUT_COMPONENTS", "DRAWING_WITHOUT_MODEL"] as const;
export type StructureGapKind = (typeof STRUCTURE_GAP_KINDS)[number];

export interface StructureGuardNode {
  cadDocumentId: string;
  /** CadDocumentType: IPT, IAM, IDW, DWG, PDF, OTHER. */
  documentType: string;
}

export interface StructureGuardEdge {
  parentCadDocumentId: string;
  childCadDocumentId: string;
  /** CadDependencyType: COMPONENT, DRAWING_REFERENCE, DERIVED, REFERENCE, OTHER. */
  dependencyType: string;
}

export interface StructureGap {
  cadDocumentId: string;
  kind: StructureGapKind;
}

/** The dependency type each document type requires, if any. */
function requiredLinkType(documentType: string): { linkType: string; kind: StructureGapKind } | null {
  switch (documentType) {
    case "IAM":
      return { linkType: "COMPONENT", kind: "ASSEMBLY_WITHOUT_COMPONENTS" };
    case "IDW":
    case "DWG":
      return { linkType: "DRAWING_REFERENCE", kind: "DRAWING_WITHOUT_MODEL" };
    default:
      return null;
  }
}

/** The two dependency types the guard reads (the wiring layer filters on them). */
export const STRUCTURE_LINK_TYPES = ["COMPONENT", "DRAWING_REFERENCE"] as const;

/**
 * Every closure document that lacks its required structure, sorted by
 * cadDocumentId (deterministic). `edges` may contain edges of any type and
 * edges whose parent is outside `nodes`; only an edge from the node itself,
 * of the required type, to a DIFFERENT document counts. (Self-edges are
 * already forbidden by the CHECK constraint CadDependency_no_self_reference;
 * ignoring them here is defence in depth.)
 */
export function findStructureGaps(
  nodes: readonly StructureGuardNode[],
  edges: readonly StructureGuardEdge[],
): StructureGap[] {
  const satisfied = new Set<string>();
  for (const edge of edges) {
    if (edge.parentCadDocumentId === edge.childCadDocumentId) continue;
    satisfied.add(`${edge.parentCadDocumentId}::${edge.dependencyType}`);
  }

  const gaps: StructureGap[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.cadDocumentId)) continue;
    seen.add(node.cadDocumentId);
    const required = requiredLinkType(node.documentType);
    if (required === null) continue;
    if (!satisfied.has(`${node.cadDocumentId}::${required.linkType}`)) {
      gaps.push({ cadDocumentId: node.cadDocumentId, kind: required.kind });
    }
  }
  return gaps.sort((a, b) =>
    a.cadDocumentId < b.cadDocumentId ? -1 : a.cadDocumentId > b.cadDocumentId ? 1 : 0,
  );
}

/**
 * Thrown inside the release transaction when the closure has structure gaps.
 * The transaction rolls back: the revision is not RELEASED, no baseline and
 * no lifecycle event are written. Carries the FIRST gap (sorted) and the
 * total count, so the dashboard can name one document and say "and N more".
 * The message holds only server-side ids, never request data.
 */
export class ReleaseStructureIncompleteError extends Error {
  readonly cadDocumentId: string;
  readonly kind: StructureGapKind;
  readonly gapCount: number;
  constructor(gaps: readonly StructureGap[]) {
    if (gaps.length === 0) {
      throw new RangeError("ReleaseStructureIncompleteError needs at least one gap");
    }
    const first = gaps[0]!;
    super(
      `Release refused: ${gaps.length} document(s) in the release have no recorded structure ` +
        `(first: ${first.cadDocumentId}, ${first.kind})`,
    );
    this.name = "ReleaseStructureIncompleteError";
    this.cadDocumentId = first.cadDocumentId;
    this.kind = first.kind;
    this.gapCount = gaps.length;
  }
}
