/**
 * Arch PLM - desktop CAD-document resolve core (P4B, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system (plus a relative import of the equally-pure `CAD_DOCUMENT_TYPES`
 * list from `copy-design-lineage-core.ts`, to avoid a THIRD copy of that
 * enum). Holds the query-parsing rules, DTO shape and domain error for the
 * ONE bootstrap lookup the Inventor CAD Connect client needs before a Get
 * Latest:
 *
 *     (organization from the verified session) + documentNumber
 *         -> authoritative stable cadDocumentId
 *
 * documentNumber is an EXPLICIT bootstrap selection only. Once the server
 * has resolved it to a `cadDocumentId`, that id is authoritative. The client
 * must never re-derive managed identity from a filename, a path, or
 * documentNumber text embedded in a filename - an already-managed workspace
 * file is bound through the verified workspace manifest + stable ids.
 *
 * P6D ROUND 2, HIGH fix: `CadDocument.documentNumber` is no longer unique by
 * itself (see `prisma/schema.prisma`'s own doc comment - it is now scoped by
 * documentType too, so a model/drawing pair sharing one engineering number
 * can coexist). A number-only lookup can therefore legitimately match MORE
 * THAN ONE document. An OPTIONAL `?documentType=` query param disambiguates;
 * when omitted and more than one document shares the number, the lookup
 * FAILS CLOSED (409 - see `desktop-cad-documents-db.ts`) rather than
 * silently picking one row - "existing number-only resolve succeeds only
 * when unique; when multiple types share the same number, require
 * documentType or the stable cadDocumentId."
 *
 * All Prisma wiring lives in `app/lib/desktop-cad-documents-db.ts`; the
 * server-only shim is `app/lib/desktop-cad-documents.ts`.
 */
import { CAD_DOCUMENT_TYPES, type CadDocumentTypeValue } from "./copy-design-lineage-core.ts";

export const DESKTOP_CAD_DOC_CONTRACT = "arch-plm.desktop-cad-document.v1";

/** Max accepted length for either query value. A documentNumber / cuid is
 *  short; anything longer is a malformed request, not a real lookup. */
export const MAX_CAD_DOC_QUERY_LENGTH = 200;

export class DesktopCadDocError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "DesktopCadDocError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export type CadDocumentQuery =
  | { kind: "documentNumber"; value: string; documentType: CadDocumentTypeValue | null }
  | { kind: "cadDocumentId"; value: string };

/**
 * Parse EXACTLY one of `?documentNumber=` or `?cadDocumentId=` from the
 * request query. Both, neither, empty, or over-length -> DesktopCadDocError(400).
 * The error message never echoes the value.
 *
 * P6D ROUND 2: an OPTIONAL `?documentType=` is accepted ONLY alongside
 * `?documentNumber=` (never alongside `?cadDocumentId=`, which is already
 * unambiguous on its own - supplying it there is a 400, not silently
 * ignored) and must be one of `CAD_DOCUMENT_TYPES` when present.
 */
export function parseCadDocumentQuery(params: URLSearchParams): CadDocumentQuery {
  const documentNumber = params.get("documentNumber");
  const cadDocumentId = params.get("cadDocumentId");
  const documentTypeRaw = params.get("documentType");

  const hasNumber = typeof documentNumber === "string" && documentNumber.trim().length > 0;
  const hasId = typeof cadDocumentId === "string" && cadDocumentId.trim().length > 0;

  if (hasNumber === hasId) {
    throw new DesktopCadDocError(
      400,
      "Provide exactly one of documentNumber or cadDocumentId.",
    );
  }

  if (hasId && documentTypeRaw !== null) {
    throw new DesktopCadDocError(400, "documentType is only meaningful alongside documentNumber.");
  }

  const raw = (hasNumber ? documentNumber : cadDocumentId) as string;
  const value = raw.trim();
  if (value.length > MAX_CAD_DOC_QUERY_LENGTH) {
    throw new DesktopCadDocError(400, "The lookup value is too long.");
  }

  if (hasId) {
    return { kind: "cadDocumentId", value };
  }

  let documentType: CadDocumentTypeValue | null = null;
  if (documentTypeRaw !== null) {
    // P6D ROUND 3, item H: PRESENT-but-blank/whitespace is a malformed
    // request (400) - it must never be silently treated the same as
    // OMITTED (documentTypeRaw === null, which keeps the existing optional
    // behavior below untouched).
    const trimmed = documentTypeRaw.trim();
    if (trimmed.length === 0) {
      throw new DesktopCadDocError(400, "documentType must not be blank when present.");
    }
    if (!(CAD_DOCUMENT_TYPES as readonly string[]).includes(trimmed)) {
      throw new DesktopCadDocError(400, `documentType must be one of ${CAD_DOCUMENT_TYPES.join(", ")}.`);
    }
    documentType = trimmed as CadDocumentTypeValue;
  }

  return { kind: "documentNumber", value, documentType };
}

export interface ResolvedCadDocumentDto {
  contract: typeof DESKTOP_CAD_DOC_CONTRACT;
  /** Authoritative stable identity. Opaque; the client never parses it. */
  cadDocumentId: string;
  /** Human identity, unique per organization ONLY when combined with
   *  documentType (P6D ROUND 2) - display / bootstrap only, never used as
   *  the sole lookup key once resolved. */
  documentNumber: string;
  /** Display only - never identity. */
  fileName: string;
  /** CadDocumentType as a plain string ("IPT", "IAM", ...). */
  cadType: string;
}
