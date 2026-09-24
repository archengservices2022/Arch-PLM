/**
 * Arch PLM - shared, pure validator for a single safe CAD file basename
 * (P6D FINAL BLOCKER FIX - durable-resume destination-escape hardening).
 *
 * Used wherever a caller-supplied string will become the LAST path
 * component of a destination file the CAD Connect desktop client
 * eventually writes to a chosen local folder - currently: the P6D Copy
 * Design reservation boundary's `newFileName` (`copy-design-lineage-core.ts`),
 * which the durable-resume operation-status endpoint later echoes back
 * verbatim as `originalFileName` (`copy-design-operation-status-core.ts`).
 * The desktop client independently re-validates that echoed value with the
 * SAME rules before ever combining it with a destination folder (see
 * `Arch.CadConnect.Core.CopyDesign.Apply.CopyDesignSafeBaseName` in the
 * Inventor repo) - this module is this repo's half of that shared
 * discipline, never the only line of defense.
 *
 * DELIBERATELY SEPARATE from `assertSafeWorkspacePath`
 * (`get-latest-core.ts`): that validator's `SAFE_PATH_SEGMENT` allowlist
 * forbids spaces, fine for an opaque, server-generated workspace-relative
 * path, but wrong here - a real CAD engineering filename routinely
 * contains spaces (e.g. "A B-C_01.ipt"), and rejecting those would refuse
 * legitimate documents, not just attacks. This validator instead uses a
 * BLOCKLIST of the specific unsafe constructs, never a character
 * allowlist, so it accepts the full realistic range of CAD filenames while
 * still rejecting every known path-escape shape.
 *
 * Pure module: no `@/` imports, no Prisma, no framework. The Windows
 * reserved-device-name set and character classes are intentionally
 * DUPLICATED (not imported) from `get-latest-core.ts`'s own copies - same
 * "keep every pure core module independently self-contained" convention
 * `checkout-core.ts` already uses for `authz.ts`'s role list.
 */

// Control characters: NUL..US (0x00-0x1F) plus DEL (0x7F). Built from a
// string so the source file stays pure ASCII (matching storage-core.ts).
const CONTROL_CHAR_CLASS = "[\u0000-\u001F\u007F]";
const HAS_CONTROL_CHAR = new RegExp(CONTROL_CHAR_CLASS);

/** Characters Windows forbids in a filename, plus ':' (drive / alternate
 *  data stream separator) - '/' and '\' are checked separately below since
 *  their presence means "this is a path, not a single basename" rather
 *  than merely "an invalid character". */
const WINDOWS_INVALID_FILENAME_CHARS = /[<>:"|?*]/;

/** Windows reserved device names (case-insensitive), matched against the
 *  basename BEFORE its first dot - so "CON", "con.ipt", "COM1.iam" and
 *  "Nul.idw" are all reserved, but "MyCOM1.ipt" is not. */
const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Generous but bounded - matches the DB column's practical ceiling; not
 *  meant to be a tight limit, only to reject an absurd/adversarial length
 *  before running any regex against it. */
const MAX_BASENAME_LENGTH = 255;

export type SafeCadBaseNameResult =
  | { safe: true }
  | { safe: false; reason: string };

/**
 * True iff `value` is exactly ONE safe file name component - never a path,
 * in any form. Rejects (see the class doc comment above for why this is a
 * blocklist, not an allowlist):
 *   - non-string, blank, or whitespace-only
 *   - longer than 255 characters
 *   - containing '/' or '\' (rules out "subdir\x", "subdir/x", a UNC path
 *     "\\server\share\x", and a rooted "C:\x" path alike)
 *   - exactly "." or ".."
 *   - a drive prefix ("C:", "D:", ...) at the start (belt-and-suspenders -
 *     "C:\x" is already caught by the backslash check above, but a bare
 *     "C:x" drive-relative form is not, so this is checked independently)
 *   - any Windows-invalid filename character: < > : " | ? *
 *   - any ASCII control character (0x00-0x1F, 0x7F)
 *   - a trailing '.' or trailing ' '
 *   - a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 *     case-insensitive, with or without an extension
 *
 * Never sanitizes or mutates `value` - this is a pure yes/no (plus a
 * human-readable reason on "no") predicate; every caller fails closed on
 * `safe: false` rather than attempting to fix the value up.
 */
export function isSafeCadBaseName(value: unknown): SafeCadBaseNameResult {
  if (typeof value !== "string") {
    return { safe: false, reason: "must be a string" };
  }
  if (value.length === 0) {
    return { safe: false, reason: "blank" };
  }
  if (value.trim().length === 0) {
    return { safe: false, reason: "whitespace-only" };
  }
  if (value.length > MAX_BASENAME_LENGTH) {
    return { safe: false, reason: `longer than ${MAX_BASENAME_LENGTH} characters` };
  }
  if (value.includes("/") || value.includes("\\")) {
    return { safe: false, reason: "contains a path separator ('/' or '\\')" };
  }
  if (value === "." || value === "..") {
    return { safe: false, reason: "\".\" or \"..\" is not a file name" };
  }
  if (/^[A-Za-z]:/.test(value)) {
    return { safe: false, reason: "drive prefix" };
  }
  if (HAS_CONTROL_CHAR.test(value)) {
    return { safe: false, reason: "control character" };
  }
  if (WINDOWS_INVALID_FILENAME_CHARS.test(value)) {
    return { safe: false, reason: "Windows-invalid character (one of < > : \" | ? *)" };
  }
  if (value.endsWith(".") || value.endsWith(" ")) {
    return { safe: false, reason: "trailing dot or trailing space" };
  }
  const deviceBaseName = value.split(".")[0]!.toUpperCase();
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(deviceBaseName)) {
    return { safe: false, reason: "reserved Windows device name" };
  }
  return { safe: true };
}
