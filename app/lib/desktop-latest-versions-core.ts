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
 * `FileVersion` PLUS that FileVersion's canonical immutable binary integrity
 * metadata (`fileSize` + `checksum`), so a client can cryptographically verify
 * a local binary is exactly that authoritative version (P5C prerequisite).
 *
 * AUTHORITATIVE LATEST: the existing model invariant. `FileVersion.versionNumber`
 * is a server-assigned integer, unique per `(cadDocumentId, versionNumber)`.
 * The latest version is the one with the greatest `versionNumber` - exactly
 * how check-in / checkout / release already determine it. NEVER a filename,
 * path, storage key, timestamp, or a client-supplied number.
 *
 * INTEGRITY METADATA: `fileSize` + `checksum` are read ONLY from the
 * authoritative `FileVersion` row the server selected - never from client
 * input. On top of the shared "binary-backed" base check Get Latest / Checkout
 * / Check-In use (`isBinaryBackedFileVersion`), a recognised latest result is
 * held to the CANONICAL Arch integrity shape:
 *   - `checksum` must match `/^[0-9a-f]{64}$/` EXACTLY - a lowercase-hex
 *     SHA-256 digest, 64 chars, no prefix, no whitespace. Malformed persisted
 *     data is never trimmed / lowercased / normalised into validity.
 *   - `fileSize` must be a non-negative safe integer. The raw PostgreSQL
 *     BIGINT is range-checked BEFORE any `Number(...)` conversion so an
 *     out-of-safe-range value can never be silently rounded and trusted.
 * If the selected latest `FileVersion` fails either check the result FAILS
 * CLOSED to `recognized: false` - it never advertises a latest target a client
 * cannot verify, and it never falls back to an older version's metadata.
 *
 * OPAQUE IDENTIFIERS: `cadDocumentId` / `FileVersion.id` are opaque exact
 * identities. This module never `.trim()`s, lower/upper-cases, or otherwise
 * normalises them. A blank / whitespace-padded / over-length id is a MALFORMED
 * REQUEST (400) - never silently repaired into a valid id.
 *
 * All Prisma wiring is in `desktop-latest-versions-db.ts`; the `server-only`
 * shim is `desktop-latest-versions.ts`.
 */

import { isBinaryBackedFileVersion } from "./file-version-resolution-core.ts";

/** The response contract identifier the CAD Connect client requires. */
export const DESKTOP_LATEST_VERSIONS_CONTRACT = "arch-plm.desktop-latest-versions.v1";

/**
 * A canonical Arch content checksum: the lowercase-hex SHA-256 digest exactly
 * as `storage-core.ts` computes it (`createHash("sha256").digest("hex")`) and
 * as the download endpoint / release verification compare it - 64 chars,
 * `0-9a-f` only, no `sha256:` prefix, no surrounding or internal whitespace.
 *
 * A `null`, empty, whitespace-only, whitespace-padded, wrong-length, prefixed,
 * non-hex, or upper-cased value is NOT canonical and is never repaired into
 * validity. The explicit `length === 64` guard also rejects a trailing newline
 * that the regex `$` would otherwise tolerate.
 */
export function isCanonicalSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Narrow a persisted PostgreSQL BIGINT byte size to a safe JS number, or
 * `null` when it is absent OR cannot be represented without rounding.
 *
 * The raw `bigint` is bounds-checked
 * (`0 <= v <= BigInt(Number.MAX_SAFE_INTEGER)`) BEFORE `Number(...)` so a value
 * such as the signed-BIGINT max `9223372036854775807` is rejected outright
 * rather than silently rounded. The converted number is then re-checked with
 * `Number.isSafeInteger`. `null` here means "fail this id closed" - callers
 * must NOT fall back to an older FileVersion.
 */
export function toSafeFileSize(raw: bigint | null | undefined): number | null {
  if (typeof raw !== "bigint") {
    return null;
  }
  if (raw < BigInt(0) || raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

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
      /** Canonical immutable byte size of the authoritative latest
       *  `FileVersion` (finite, non-negative). From the selected DB row only. */
      fileSize: number;
      /** Canonical immutable content checksum of the authoritative latest
       *  `FileVersion` - the SAME representation the download endpoint verifies
       *  and Get Latest reports (`X-Content-SHA256`). From the selected DB row
       *  only, never client input. */
      checksum: string;
    }
  | {
      cadDocumentId: string;
      recognized: false;
    };

export interface LatestVersionsResponseDto {
  contract: typeof DESKTOP_LATEST_VERSIONS_CONTRACT;
  results: LatestVersionResultDto[];
}

/**
 * The authoritative latest `FileVersion` for one `CadDocument`, as looked up.
 *
 * `checksum` is carried through VERBATIM from the selected DB row (never
 * trimmed / cased). `fileSize` is the wiring layer's {@link toSafeFileSize}
 * result: a non-negative safe integer, or `null` when the stored BIGINT is
 * absent or outside the safely representable range. Either field being `null`
 * / non-canonical makes {@link buildLatestVersionResults} fail that id closed -
 * there is no fallback to an older version.
 */
export interface AuthoritativeLatest {
  latestFileVersionId: string;
  latestVersionNumber: number;
  fileSize: number | null;
  checksum: string | null;
}

/**
 * Assemble the response `results[]` in the SAME ORDER as the requested ids.
 *
 * `recognized: true` ONLY when the exact id is a `CadDocument` in the actor's
 * org (`recognizedDocIds`) AND an authoritative latest `FileVersion` exists
 * for it (`latestByDoc`) AND that latest `FileVersion` carries COMPLETE, VALID
 * CANONICAL integrity metadata:
 *   - `isBinaryBackedFileVersion` (the shared base check), AND
 *   - `checksum` matches `/^[0-9a-f]{64}$/` exactly ({@link isCanonicalSha256}), AND
 *   - `fileSize` is a non-negative safe integer (the raw BIGINT was already
 *     range-checked by {@link toSafeFileSize} before conversion).
 * Everything else - unknown id, cross-tenant id, a document with no
 * `FileVersion`, or a latest `FileVersion` whose stored integrity metadata is
 * missing / non-canonical / out-of-range - is `recognized: false`,
 * indistinguishable from an unknown id. There is NO fallback to an older
 * version. Ids are emitted verbatim.
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

    // Fail closed: never advertise a latest target whose canonical integrity
    // metadata is absent, malformed, or out of safe range - a client could not
    // (or should not) verify a local binary against it.
    if (
      !isBinaryBackedFileVersion(latest) ||
      !isCanonicalSha256(latest.checksum) ||
      latest.fileSize === null ||
      !Number.isSafeInteger(latest.fileSize) ||
      latest.fileSize < 0
    ) {
      return { cadDocumentId, recognized: false };
    }

    return {
      cadDocumentId,
      recognized: true,
      latestFileVersionId: latest.latestFileVersionId,
      latestVersionNumber: latest.latestVersionNumber,
      fileSize: latest.fileSize,
      checksum: latest.checksum,
    };
  });
}
