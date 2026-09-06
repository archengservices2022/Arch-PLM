/**
 * Arch PLM - desktop CAD-document resolve core (P4B, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds the query-parsing rules, DTO shape and domain error for the
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
 * All Prisma wiring lives in `app/lib/desktop-cad-documents-db.ts`; the
 * server-only shim is `app/lib/desktop-cad-documents.ts`.
 */

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
  | { kind: "documentNumber"; value: string }
  | { kind: "cadDocumentId"; value: string };

/**
 * Parse EXACTLY one of `?documentNumber=` or `?cadDocumentId=` from the
 * request query. Both, neither, empty, or over-length -> DesktopCadDocError(400).
 * The error message never echoes the value.
 */
export function parseCadDocumentQuery(params: URLSearchParams): CadDocumentQuery {
  const documentNumber = params.get("documentNumber");
  const cadDocumentId = params.get("cadDocumentId");

  const hasNumber = typeof documentNumber === "string" && documentNumber.trim().length > 0;
  const hasId = typeof cadDocumentId === "string" && cadDocumentId.trim().length > 0;

  if (hasNumber === hasId) {
    throw new DesktopCadDocError(
      400,
      "Provide exactly one of documentNumber or cadDocumentId.",
    );
  }

  const raw = (hasNumber ? documentNumber : cadDocumentId) as string;
  const value = raw.trim();
  if (value.length > MAX_CAD_DOC_QUERY_LENGTH) {
    throw new DesktopCadDocError(400, "The lookup value is too long.");
  }

  return hasNumber
    ? { kind: "documentNumber", value }
    : { kind: "cadDocumentId", value };
}

export interface ResolvedCadDocumentDto {
  contract: typeof DESKTOP_CAD_DOC_CONTRACT;
  /** Authoritative stable identity. Opaque; the client never parses it. */
  cadDocumentId: string;
  /** Human identity, unique per organization. Display / bootstrap only. */
  documentNumber: string;
  /** Display only - never identity. */
  fileName: string;
  /** CadDocumentType as a plain string ("IPT", "IAM", ...). */
  cadType: string;
}
