// ============================================================
// Arch PLM - FE-L3: keep what the user typed after a refusal notice
//
// Pure: no I/O and no Next.js / React imports, so the plain Node test runner
// can load it. Used by app/actions.ts and app/admin/users/actions.ts (server)
// and app/components/keep-input-form.tsx (fields rendered with the state).
//
// A form wrapped in <KeepInputForm> calls its Server Action through
// useActionState. When the action is REFUSED with a user-correctable notice,
// it returns the notice's fixed message plus the submitted values of an
// explicit per-form allowlist of fields. The fields (<KeptInput>,
// <KeptSelect>) render those values as their defaultValue - at render time,
// so it also works for a plain (no-JavaScript) form POST.
//
// SECRETS ARE NEVER ECHOED
//   1. Only the fields named in the form's allowlist (KEPT_FORM_FIELDS) are
//      returned - never "everything in the FormData".
//   2. A field whose NAME looks like a secret (password, passwordConfirmation,
//      token, secret, ...) is never returned, even if an allowlist names it.
//   3. When rendering, a password, hidden or file input never takes a kept
//      value, whatever the state contains (password fields stay empty).
// Values are plain strings only (files are dropped). They are not shortened:
// the kept fields have no server-side length limit below the Server Action
// request body limit (Next.js default 1 MB), which already bounds them.
// The notice is still the fixed allowlisted message; React renders the kept
// values as field values, never as markup.
// ============================================================

/** What a kept-input Server Action returns to useActionState. */
export interface KeptFormState {
  /** Increments with every returned state (the client re-mounts the form on change). */
  readonly submission: number;
  /** The fixed, allowlisted message of a refusal; null after a success. */
  readonly notice: string | null;
  /** The submitted non-secret values to show again (only after a refusal). */
  readonly values: Readonly<Record<string, string>>;
}

export const INITIAL_KEPT_FORM_STATE: KeptFormState = Object.freeze({
  submission: 0,
  notice: null,
  values: Object.freeze({}),
});

/** The fields each kept-input form may get back. No secret ever belongs here. */
export const KEPT_FORM_FIELDS = Object.freeze({
  createItem: Object.freeze([
    "itemNumber",
    "description",
    "type",
    "projectId",
    "revision",
    "revisionDescription",
  ] as const),
  createCadDocument: Object.freeze(["itemRevisionId", "fileName", "documentNumber", "documentType"] as const),
  // B05: the password pair is deliberately NOT kept; the admin types it again.
  createUser: Object.freeze(["email", "name", "role"] as const),
});

const SECRET_FIELD_NAME = /pass|secret|token|credential|api[-_]?key|otp/i;

/** True for a field name that may hold a secret; such a field is never kept. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAME.test(name);
}

/**
 * The submitted values of `fields` that may be shown again: allowlisted,
 * not secret-looking, plain strings (kept in full, as typed).
 */
export function keptFormValues(
  formData: { get(name: string): unknown },
  fields: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of fields) {
    if (isSecretFieldName(name)) continue;
    const value = formData.get(name);
    if (typeof value !== "string") continue;
    values[name] = value;
  }
  return values;
}

/** The next submission number; `previous` comes from the browser, so it is checked. */
function nextSubmission(previous: unknown): number {
  const n =
    typeof previous === "object" && previous !== null
      ? (previous as { submission?: unknown }).submission
      : undefined;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n < 1_000_000_000 ? n + 1 : 1;
}

/** The state after a refusal: the fixed notice plus the kept, non-secret values. */
export function refusedFormState(
  previous: unknown,
  notice: string,
  formData: { get(name: string): unknown },
  fields: readonly string[],
): KeptFormState {
  return { submission: nextSubmission(previous), notice, values: keptFormValues(formData, fields) };
}

/** The state after a success: no notice, no values (the form shows its defaults again). */
export function completedFormState(previous: unknown): KeptFormState {
  return { submission: nextSubmission(previous), notice: null, values: {} };
}

// ------------------------------------------------------------
// Rendering: the defaultValue of a field inside a kept-input form
// ------------------------------------------------------------

/** Input types that never take a kept value. */
const NEVER_KEPT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "password",
  "hidden",
  "file",
  "checkbox",
  "radio",
  "submit",
  "button",
  "reset",
  "image",
]);

function keptValue(values: Readonly<Record<string, unknown>>, name: string): string | undefined {
  if (isSecretFieldName(name) || !Object.prototype.hasOwnProperty.call(values, name)) return undefined;
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/** The defaultValue of an <input>: the kept value if allowed, else `fallback`. */
export function keptInputDefault<F>(
  values: Readonly<Record<string, unknown>>,
  name: string,
  type: string | undefined,
  fallback: F,
): string | F {
  if (type !== undefined && NEVER_KEPT_INPUT_TYPES.has(type.toLowerCase())) return fallback;
  return keptValue(values, name) ?? fallback;
}

/** The defaultValue of a <select>: the kept value only if it is still one of `options`. */
export function keptSelectDefault<F>(
  values: Readonly<Record<string, unknown>>,
  name: string,
  options: readonly string[],
  fallback: F,
): string | F {
  const kept = keptValue(values, name);
  return kept !== undefined && options.includes(kept) ? kept : fallback;
}
