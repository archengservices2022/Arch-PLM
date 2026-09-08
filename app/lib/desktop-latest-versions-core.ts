/**
 * Arch PLM - desktop "authoritative latest CAD FileVersion" lookup core
 * (P5B-B server companion). Pure module: no `@/` imports, no Prisma, no
 * framework - only the type system.
 *
 * This is the smallest READ-ONLY server side the already-reviewed Arch CAD
 * Connect P5B-B client needs. For a batch of EXACT stable `cadDocumentId`s the
 * client already holds (from its verified workspace manifest), the server
 * reports - within the authenticated actor's organization only - whether each
 * id is recognised and, if so, the id + number of its authoritative latest
 * `FileVersion`.
 *
 * AUTHORITATIVE LATEST: the existing model invariant. `FileVersion.versionNumber`
 * is a server-assigned integer, unique per `(cadDocumentId, versionNumber)`.
 * The latest version is the one with the greatest `versionNumber` - exactly
 * how check-in / checkout / release already determine it. NEVER a filename,
 * path, storage key, timestamp, or a client-supplied number.
 *
 * OPAQUE IDENTIFIERS: `cadDocumentId` / `FileVersion.id` are opaque exact
 * identities. This module never `.trim()`s, lower/upper-cases, or otherwise
 * normalises them. A blank / whitespace-padded / over-length id is a MALFORMED
 * REQUEST (400) - never silently repaired into a valid id.
 *
 * All Prisma wiring is in `desktop-latest-versions-db.ts`; the `server-only`
 * shim is `desktop-latest-versions.ts`.
 */

/** The response contract identifier the CAD Connect client requires. */
export const DESKTOP_LATEST_VERSIONS_CONTRACT = "arch-plm.desktop-latest-versions.v1";

/**
 * Max `cadDocumentId` parameters accepted in one request. Matches the client's
 * own `MaxIdsPerRequest` cap so a well-formed client request is never rejected,
 * while an unbounded query is refused with a deterministic 400.
 */
export const MAX_LATEST_VERSION_IDS = 200;

/**
 * Max accepted length for a single `cadDocumentId`. A cuid is ~25 chars;
 * anything materially longer is a malformed request, not a real id.
 */
export const MAX_LATEST_VERSION_ID_LENGTH = 200;

export class DesktopLatestVersionError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "DesktopLatestVersionError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/** True when a value has leading/trailing whitespace - an opaque id must not. */
function hasSurroundingWhitespace(value: string): boolean {
  return value.length > 0 && value.trim().length !== value.length;
}

/**
 * Parse and validate the `?cadDocumentId=<id>&cadDocumentId=<id>...` query.
 *
 * - at least one `cadDocumentId` is required
 * - no more than {@link MAX_LATEST_VERSION_IDS}
 * - every value must be a non-blank, non-whitespace-padded, in-bounds string -
 *   values are used VERBATIM (never trimmed / normalised)
 * - exact-ordinal duplicates are collapsed (order of first occurrence kept)
 *
 * Any violation throws `DesktopLatestVersionError(400)`; the message never
 * echoes a submitted value.
 */
export function parseLatestVersionIds(params: URLSearchParams): string[] {
  const raw = params.getAll("cadDocumentId");

  if (raw.length === 0) {
    throw new DesktopLatestVersionError(
      400,
      "Provide at least one cadDocumentId parameter.",
    );
  }
  if (raw.length > MAX_LATEST_VERSION_IDS) {
    throw new DesktopLatestVersionError(
      400,
      `Too many cadDocumentId parameters (max ${MAX_LATEST_VERSION_IDS}).`,
    );
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
      throw new DesktopLatestVersionError(400, "A cadDocumentId parameter is blank.");
    }
    if (hasSurroundingWhitespace(value)) {
      throw new DesktopLatestVersionError(
        400,
        "A cadDocumentId parameter has leading or trailing whitespace.",
      );
    }
    if (value.length > MAX_LATEST_VERSION_ID_LENGTH) {
      throw new DesktopLatestVersionError(400, "A cadDocumentId parameter is too long.");
    }
    if (!seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }

  return ids;
}

/** One authoritative-latest result for one requested `cadDocumentId`. */
export type LatestVersionResultDto =
  | {
      cadDocumentId: string;
      recognized: true;
      latestFileVersionId: string;
      latestVersionNumber: number;
    }
  | {
      cadDocumentId: string;
      recognized: false;
    };

export interface LatestVersionsResponseDto {
  contract: typeof DESKTOP_LATEST_VERSIONS_CONTRACT;
  results: LatestVersionResultDto[];
}

/** The authoritative latest `FileVersion` for one `CadDocument`, as looked up. */
export interface AuthoritativeLatest {
  latestFileVersionId: string;
  latestVersionNumber: number;
}

/**
 * Assemble the response `results[]` in the SAME ORDER as the requested ids.
 *
 * `recognized: true` ONLY when the exact id is a `CadDocument` in the actor's
 * org (`recognizedDocIds`) AND an authoritative latest `FileVersion` exists
 * for it (`latestByDoc`). Everything else - unknown id, cross-tenant id, a
 * document with no `FileVersion` - is `recognized: false`, indistinguishable
 * from an unknown id. Ids are emitted verbatim.
 */
export function buildLatestVersionResults(
  requestedIds: readonly string[],
  recognizedDocIds: ReadonlySet<string>,
  latestByDoc: ReadonlyMap<string, AuthoritativeLatest>,
): LatestVersionResultDto[] {
  return requestedIds.map((cadDocumentId) => {
    const latest = recognizedDocIds.has(cadDocumentId)
      ? latestByDoc.get(cadDocumentId)
      : undefined;

    if (latest === undefined) {
      return { cadDocumentId, recognized: false };
    }
    return {
      cadDocumentId,
      recognized: true,
      latestFileVersionId: latest.latestFileVersionId,
      latestVersionNumber: latest.latestVersionNumber,
    };
  });
}
