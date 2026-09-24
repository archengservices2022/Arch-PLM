/**
 * Arch PLM - desktop "authoritative drawing association" lookup core (P6D
 * Drawing Association Authority). Pure module: no `@/` imports, no Prisma, no
 * framework - only the type system.
 *
 * BACKGROUND: the CAD Connect client's Copy Design Preview needs to answer
 * "which drawing(s) authoritatively belong to this model?" before it can plan
 * a safe multi-document copy. Until now no server authority for that reverse
 * lookup existed - the client's `IDrawingAssociationSource` shipped only a
 * stub that always reports NOT AVAILABLE (see the Inventor repo's
 * `DrawingAssociation.cs`), and the planner therefore always fails the
 * drawing-association-completeness check. THIS endpoint is that authority.
 *
 * AUTHORITATIVE SOURCE: the `CadDependency` row(s) where
 * `dependencyType = DRAWING_REFERENCE` and `childDocumentId` is the model
 * being asked about - "DRAWING_REFERENCE: IDW/DWG drawing references an
 * IAM/IPT model" (see prisma/schema.prisma's own enum comment), i.e. the
 * DRAWING is the `parentDocument`, the MODEL is the `childDocument`. This is
 * the SAME row a P6D fixture creates: `parentDocumentId` = the drawing,
 * `childDocumentId` = the model. This module never infers ownership from a
 * file name - only from this exact relationship.
 *
 * SAME documentNumber, different documentType (P6D ROUND 2): a model and its
 * drawing may legitimately share one engineering number - this lookup is
 * entirely keyed by stable `cadDocumentId`, so that coexistence never
 * confuses which document is which.
 *
 * For a batch of EXACT stable `cadDocumentId`s (models the client already
 * holds from a verified workspace manifest / resolve), the server reports -
 * within the authenticated actor's organization only - whether each id is a
 * recognized CadDocument and, if so, EVERY drawing that authoritatively
 * references it, each with its own stable identity and current FileVersion
 * (if any). `recognized: true` with an EMPTY `drawings` array is a legitimate,
 * distinct answer ("this model genuinely has no drawing yet") from
 * `recognized: false` (the id itself could not be confirmed in this tenant) -
 * the two must never be collapsed into one meaning.
 *
 * All Prisma wiring is in `desktop-drawing-associations-db.ts`; the
 * `server-only` shim is `desktop-drawing-associations.ts`.
 */

/** The response contract identifier the CAD Connect client requires. */
export const DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT = "arch-plm.desktop-drawing-associations.v1";

/** Max `cadDocumentId` parameters accepted in one request. */
export const MAX_DRAWING_ASSOCIATION_IDS = 200;

/** Max accepted length for a single `cadDocumentId`. A cuid is ~25 chars;
 *  anything materially longer is a malformed request, not a real id. */
export const MAX_DRAWING_ASSOCIATION_ID_LENGTH = 200;

export class DesktopDrawingAssociationError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "DesktopDrawingAssociationError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/** True when a value has leading/trailing whitespace - an opaque id must not. */
function hasSurroundingWhitespace(value: string): boolean {
  return value.length > 0 && value.trim().length !== value.length;
}

/**
 * Parse and validate the `?cadDocumentId=<id>&cadDocumentId=<id>...` query -
 * the model ids the client is asking about. Same shape/limits as the P5B-B
 * latest-versions batch lookup (deliberately its own independent copy, not a
 * shared import, matching this repo's existing per-endpoint convention):
 *
 * - at least one `cadDocumentId` is required
 * - no more than {@link MAX_DRAWING_ASSOCIATION_IDS}
 * - every value must be a non-blank, non-whitespace-padded, in-bounds string -
 *   values are used VERBATIM (never trimmed / normalised)
 * - exact-ordinal duplicates are collapsed (order of first occurrence kept)
 *
 * Any violation throws `DesktopDrawingAssociationError(400)`; the message
 * never echoes a submitted value.
 */
export function parseDrawingAssociationModelIds(params: URLSearchParams): string[] {
  const raw = params.getAll("cadDocumentId");

  if (raw.length === 0) {
    throw new DesktopDrawingAssociationError(
      400,
      "Provide at least one cadDocumentId parameter.",
    );
  }
  if (raw.length > MAX_DRAWING_ASSOCIATION_IDS) {
    throw new DesktopDrawingAssociationError(
      400,
      `Too many cadDocumentId parameters (max ${MAX_DRAWING_ASSOCIATION_IDS}).`,
    );
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
      throw new DesktopDrawingAssociationError(400, "A cadDocumentId parameter is blank.");
    }
    if (hasSurroundingWhitespace(value)) {
      throw new DesktopDrawingAssociationError(
        400,
        "A cadDocumentId parameter has leading or trailing whitespace.",
      );
    }
    if (value.length > MAX_DRAWING_ASSOCIATION_ID_LENGTH) {
      throw new DesktopDrawingAssociationError(400, "A cadDocumentId parameter is too long.");
    }
    if (!seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }

  return ids;
}

/** One drawing an authoritative `DRAWING_REFERENCE` row associates with the
 *  requested model. `currentFileVersionId` is `null` when the drawing
 *  CadDocument exists but has never had a FileVersion uploaded - the client
 *  treats that exactly like an incomplete/unresolved managed reference. */
export interface AssociatedDrawingDto {
  cadDocumentId: string;
  documentNumber: string;
  fileName: string;
  /** CadDocumentType as a plain string ("IDW", "DWG", ...) - the server's own
   *  authoritative type, never derived from a file extension. */
  cadType: string;
  currentFileVersionId: string | null;
}

/** One requested model's authoritative drawing set, or `recognized: false`
 *  when the id itself could not be confirmed as a CadDocument in this
 *  tenant. `recognized: true` with an empty `drawings` array is a distinct,
 *  legitimate "this model has no drawing" answer. */
export type DrawingAssociationResultDto =
  | { cadDocumentId: string; recognized: true; drawings: AssociatedDrawingDto[] }
  | { cadDocumentId: string; recognized: false };

export interface DrawingAssociationsResponseDto {
  contract: typeof DESKTOP_DRAWING_ASSOCIATIONS_CONTRACT;
  results: DrawingAssociationResultDto[];
}
