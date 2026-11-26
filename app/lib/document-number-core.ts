/**
 * Arch PLM - document number of a CAD document attached from the dashboard
 * (DD-ATTACH; D-D decision record Rev1, DD-3(a): pilot document numbers are
 * entered WITHOUT the file extension).
 *
 * Before this module the dashboard "CAD documents > Attach" form had no
 * document-number field, so the server stored the FILE NAME - extension
 * included - as the document number. Now:
 *   - the form has a Document number field, pre-filled in the browser with the
 *     file name's stem (the name without a known CAD extension), editable;
 *   - the server uses the submitted number, or - when it is left empty (or the
 *     browser runs no JavaScript) - the same stem of the file name;
 *   - the server REFUSES a number that still ends in a known CAD / drawing
 *     extension (case-insensitive), so "10073-MFD-AS210.iam" can no longer be
 *     stored as a number through this form.
 *
 * Only KNOWN extensions count: a number such as "PUMP-REV.2" or "ASSY.A" is a
 * legitimate number, not a file name, and stays accepted.
 *
 * Pure module (no imports): used by the Server Action and by the client form.
 */

/** File extensions that mark a value as a FILE NAME rather than a document
 *  number: the CadDocumentType extensions (IPT, IAM, IDW, DWG, PDF) plus the
 *  other Inventor / exchange formats an engineer may attach. Lower case. */
export const CAD_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ipt", "iam", "idw", "dwg", "pdf", "ipn", "dxf", "step", "stp", "iges", "igs", "sat", "stl",
]);

/** The known CAD extension the value ends with (lower case, without the dot), or null. */
export function knownCadExtension(value: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot < 0 || dot === value.length - 1) return null;
  const ext = value.slice(dot + 1).toLowerCase();
  return CAD_FILE_EXTENSIONS.has(ext) ? ext : null;
}

/** The file name without ONE trailing known CAD extension, trimmed.
 *  "10073-MFD-AS210.iam" -> "10073-MFD-AS210"; "A.B.ipt" -> "A.B";
 *  "notes.txt" -> "notes.txt" (unknown extension: unchanged); ".ipt" -> "" (then refused as empty). */
export function fileNameStem(fileName: string): string {
  const trimmed = fileName.trim();
  return knownCadExtension(trimmed) ? trimmed.slice(0, trimmed.lastIndexOf(".")).trim() : trimmed;
}

export type AttachDocumentNumberResult =
  | { ok: true; documentNumber: string }
  | { ok: false; reason: "HAS_EXTENSION" | "EMPTY" };

/**
 * The document number the Attach form stores. `submitted` is the trimmed field
 * value or undefined when the field was empty / absent; `fileName` is the
 * trimmed, required file name.
 */
export function resolveAttachDocumentNumber(
  submitted: string | undefined,
  fileName: string,
): AttachDocumentNumberResult {
  const documentNumber = submitted ?? fileNameStem(fileName);
  if (documentNumber === "") return { ok: false, reason: "EMPTY" };
  if (knownCadExtension(documentNumber)) return { ok: false, reason: "HAS_EXTENSION" };
  return { ok: true, documentNumber };
}
