import {
  InvalidLifecycleCommentError,
  LIFECYCLE_DENIAL_MESSAGES,
  MAX_LIFECYCLE_COMMENT_LENGTH,
  type LifecycleDenialCode,
} from "./lifecycle-policy-core.ts";
import {
  LEGACY_REVALIDATION_MESSAGES,
  LegacyRevalidationError,
  type LegacyRevalidationCode,
} from "./legacy-revalidation-core.ts";
import {
  LifecycleStateError,
  type LifecycleStateErrorCode,
} from "./lifecycle-errors-core.ts";
import {
  ReleaseStructureIncompleteError,
  type StructureGapKind,
} from "./release-structure-guard-core.ts";

// ============================================================
// Arch PLM - safe refusal notices for Server Actions (pilot UX fixes)
//
// Pure: no I/O and no Next.js imports, so the plain Node test runner can load
// it. Used by app/actions.ts, app/page.tsx and app/login/page.tsx.
//
// KI-1  A refused sign-in (wrong email or password, inactive account) is
//       shown as one generic message instead of an error page.
// KI-2  An EXPECTED refusal of a lifecycle, revalidation or "Create next
//       revision" action is shown as a fixed message on the dashboard
//       instead of an error page.
//
// SAFETY RULES
//   1. Only refusals on the explicit allowlist below become notices.
//      Anything else - unexpected errors, database errors, bugs - is
//      rethrown unchanged and reaches the error boundary (app/error.tsx).
//   2. Next.js control-flow errors (redirect, notFound, ...) are NEVER
//      treated as refusals; they are rethrown before classification.
//   3. The URL carries only a notice CODE. The page shows the fixed message
//      for an allowlisted code and ignores any other value, so no text from
//      the URL is ever rendered.
//   4. Classification happens after the action has already failed: the
//      refusals are all raised before any write or inside a transaction that
//      rolled back. Nothing about permissions or transactions changes here.
// ============================================================

// ------------------------------------------------------------
// Next.js control flow
// ------------------------------------------------------------

/**
 * Digests of the errors Next.js throws to implement redirect(), notFound(),
 * forbidden()/unauthorized() and request-time APIs. They must always
 * propagate. (app/actions.ts additionally calls Next's own
 * `unstable_rethrow` first; this check keeps the pure layer safe on its own.)
 */
const NEXT_CONTROL_FLOW_DIGEST_PREFIXES = [
  "NEXT_REDIRECT",
  "NEXT_NOT_FOUND",
  "NEXT_HTTP_ERROR_FALLBACK",
  "DYNAMIC_SERVER_USAGE",
  "BAILOUT_TO_CLIENT_SIDE_RENDERING",
  "NEXT_PRERENDER_INTERRUPTED",
  "HANGING_PROMISE_REJECTION",
] as const;

export function isNextControlFlowError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  return (
    typeof digest === "string" &&
    NEXT_CONTROL_FLOW_DIGEST_PREFIXES.some((prefix) => digest.startsWith(prefix))
  );
}

// ------------------------------------------------------------
// Refusals raised directly by app/actions.ts
// ------------------------------------------------------------

export type ActionRefusalCode =
  | "TARGET_STATE_REQUIRED"
  | "CREATE_NEXT_SOURCE_NOT_FOUND"
  | "CREATE_NEXT_HELD_SOURCE"
  | "CREATE_NEXT_NOT_ELIGIBLE"
  | "CREATE_NEXT_REVISION_LIMIT"
  | "CREATE_NEXT_REVISION_EXISTS"
  | "CREATE_NEXT_ROLE_NOT_PERMITTED"
  | "ROLE_NOT_PERMITTED"
  // Form / data refusals (form-errors follow-up to SD-I1):
  | "FIELD_REQUIRED"
  | "FIELD_INVALID"
  | "REVISION_LETTER_INVALID"
  | "ITEM_NUMBER_EXISTS"
  | "PROJECT_NOT_FOUND"
  | "ITEM_REVISION_NOT_FOUND"
  | "CAD_DOCUMENT_NOT_FOUND"
  | "CAD_DOCUMENT_NOT_ON_SOURCE"
  | "CAD_DOCUMENT_EXISTS"
  | "REVISION_TERMINAL_FOR_CAD"
  | "CAD_SELF_DEPENDENCY"
  | "CAD_DEPENDENCY_CYCLE"
  | "CAD_DEPENDENCY_EXISTS"
  | "CAD_GRAPH_TOO_LARGE"
  | "CONCURRENT_CHANGES";

/**
 * An expected refusal raised by a Server Action itself. `message` keeps the
 * text the action has always used (server logs, callers); the dashboard shows
 * the fixed notice for `code` instead.
 */
export class ActionRefusalError extends Error {
  readonly code: ActionRefusalCode;
  constructor(code: ActionRefusalCode, message: string = ACTION_REFUSAL_MESSAGES[code]) {
    super(message);
    this.name = "ActionRefusalError";
    this.code = code;
  }
}

export const ACTION_REFUSAL_MESSAGES: Record<ActionRefusalCode, string> = {
  TARGET_STATE_REQUIRED: "Choose the state to move this revision to, then select Update.",
  CREATE_NEXT_SOURCE_NOT_FOUND:
    "That revision was not found. Refresh the page and try again.",
  CREATE_NEXT_HELD_SOURCE:
    "This legacy revision cannot be used as the source for a new revision. Use “Revalidate as new revision” instead.",
  CREATE_NEXT_NOT_ELIGIBLE:
    "A new revision can only be created from an Approved or Released revision.",
  CREATE_NEXT_REVISION_LIMIT:
    "This item has reached revision Z; revisions beyond Z are not supported yet.",
  CREATE_NEXT_REVISION_EXISTS:
    "The next revision already exists for this item. Refresh the page to see it.",
  CREATE_NEXT_ROLE_NOT_PERMITTED:
    "Your role does not allow creating new revisions.",
  ROLE_NOT_PERMITTED: "Your role does not allow making changes. Ask an administrator if you need access.",
  FIELD_REQUIRED: "Fill in all required fields, then try again.",
  FIELD_INVALID: "One of the submitted values is not valid. Refresh the page and try again.",
  REVISION_LETTER_INVALID: "The revision must be a single letter A–Z.",
  ITEM_NUMBER_EXISTS: "An item with that item number already exists.",
  PROJECT_NOT_FOUND: "That project was not found. Refresh the page and try again.",
  ITEM_REVISION_NOT_FOUND: "That revision was not found. Refresh the page and try again.",
  CAD_DOCUMENT_NOT_FOUND: "That CAD document was not found. Refresh the page and try again.",
  CAD_DOCUMENT_NOT_ON_SOURCE:
    "A selected CAD document is not linked to the source revision. Refresh the page and try again.",
  CAD_DOCUMENT_EXISTS: "A CAD document with that document number and type already exists.",
  REVISION_TERMINAL_FOR_CAD:
    "CAD documents cannot be added to or linked to a released or terminal revision.",
  CAD_SELF_DEPENDENCY: "A CAD document cannot depend on itself.",
  CAD_DEPENDENCY_CYCLE: "That dependency would create a circular reference between CAD documents.",
  CAD_DEPENDENCY_EXISTS: "That CAD dependency already exists.",
  CAD_GRAPH_TOO_LARGE:
    "The CAD reference graph is too large to check safely. Contact an administrator.",
  CONCURRENT_CHANGES:
    "The change could not be saved because of concurrent changes. Please try again.",
};

/**
 * FE-M1: bounded retry for SERIALIZABLE transactions. `attempt` runs the whole
 * transaction; an error `isConflict` accepts (Prisma P2034) is retried until
 * `maxAttempts` have failed, and the LAST conflict becomes the typed
 * CONCURRENT_CHANGES refusal (the transaction has rolled back, the user can
 * simply try again). Any other error - including an ActionRefusalError raised
 * inside the transaction - propagates unchanged on the attempt it occurs.
 * `onExhausted` receives the final conflict (server-side logging only).
 */
export async function retryOnSerializationConflict<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: {
    isConflict: (error: unknown) => boolean;
    exhaustedMessage: string;
    maxAttempts?: number;
    onExhausted?: (error: unknown) => void;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  // FE-I1: a non-integer (e.g. NaN) would never satisfy `>=` and retry forever.
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer (got ${String(maxAttempts)})`);
  }
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      if (!options.isConflict(error)) throw error;
      if (attemptNumber >= maxAttempts) {
        options.onExhausted?.(error);
        throw new ActionRefusalError("CONCURRENT_CHANGES", options.exhaustedMessage);
      }
    }
  }
}

/**
 * True for a unique-constraint violation (Prisma P2002) whose target names
 * EVERY one of `fields` (array form) or contains each of them (the string /
 * index-name form, e.g. "Item_organizationId_itemNumber_key"). Duck-typed on
 * `code` + `meta.target` so this stays pure; callers decide which constraint
 * means which refusal, and any other P2002 is left alone.
 */
export function isUniqueViolationOn(error: unknown, fields: readonly string[]): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    const names = target.filter((field): field is string => typeof field === "string");
    return fields.every((field) => names.includes(field));
  }
  if (typeof target === "string") {
    return fields.every((field) => target.includes(field));
  }
  return false;
}

/**
 * SD-I1: the typed refusal for a role that may not mutate (e.g. VIEWER), so a
 * direct Server Action request gets an allowlisted notice instead of an
 * error page (HTTP 500). `canMutate` is the caller's role check
 * (hasRole(actor, PLM_WRITE_ROLES)); assertCanMutate stays the enforcing check.
 * The server-side message keeps assertCanMutate's existing wording.
 */
export function refuseUnlessCanMutate(canMutate: boolean): void {
  if (!canMutate) {
    throw new ActionRefusalError(
      "ROLE_NOT_PERMITTED",
      "You do not have permission to perform this action.",
    );
  }
}

const LIFECYCLE_STATE_MESSAGES: Record<LifecycleStateErrorCode, string> = {
  REVISION_NOT_FOUND: "That revision was not found. Refresh the page and try again.",
  TERMINAL_REVISION: "Released or terminal revisions cannot be changed.",
  INVALID_TRANSITION:
    "This revision's state changed since the page was loaded, so that change is no longer possible. Check its current state and try again.",
  CONCURRENT_CHANGE:
    "The revision changed while you were updating it. Refresh and try again.",
  RETRY_EXHAUSTED:
    "Could not update the revision because of concurrent changes. Please try again.",
};

const ACTOR_NOT_ACTIVE_MESSAGE = "Your account is not active in this organization.";

const COMMENT_TOO_LONG_MESSAGE = `The comment or reason is too long (maximum ${MAX_LIFECYCLE_COMMENT_LENGTH} characters).`;

// ------------------------------------------------------------
// B06: release refused because a document in the release has no recorded
// structure. These notices may NAME the document (see NoticeSubject below).
// ------------------------------------------------------------

export type ReleaseRefusalCode = "STRUCTURE_ASSEMBLY" | "STRUCTURE_DRAWING";

const RELEASE_STRUCTURE_ADVICE =
  "Record its structure following the structure procedure, then release again.";

/** The generic messages (used when the document cannot be named). */
const RELEASE_REFUSAL_MESSAGES: Record<ReleaseRefusalCode, string> = {
  STRUCTURE_ASSEMBLY: `Release refused: an assembly in this release has no components recorded in Arch PLM. ${RELEASE_STRUCTURE_ADVICE}`,
  STRUCTURE_DRAWING: `Release refused: a drawing in this release has no model recorded in Arch PLM. ${RELEASE_STRUCTURE_ADVICE}`,
};

const RELEASE_CODE_FOR_GAP: Record<StructureGapKind, ReleaseRefusalCode> = {
  ASSEMBLY_WITHOUT_COMPONENTS: "STRUCTURE_ASSEMBLY",
  DRAWING_WITHOUT_MODEL: "STRUCTURE_DRAWING",
};

/** The messages that name the document (`label` = its document number). */
function namedReleaseMessage(code: ReleaseRefusalCode, label: string, more: number): string {
  const what =
    code === "STRUCTURE_ASSEMBLY"
      ? `assembly ${label} has no components recorded in Arch PLM`
      : `drawing ${label} has no model recorded in Arch PLM`;
  const others =
    more === 1
      ? " (1 more document in this release also needs structure.)"
      : more > 1
        ? ` (${more} more documents in this release also need structure.)`
        : "";
  return `Release refused: ${what}. ${RELEASE_STRUCTURE_ADVICE}${others}`;
}

// ------------------------------------------------------------
// The allowlist: notice code -> fixed message
// ------------------------------------------------------------

function namespaced<C extends string>(
  prefix: string,
  messages: Record<C, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, message] of Object.entries(messages) as [C, string][]) {
    out[`${prefix}.${code}`] = message;
  }
  return out;
}

const NOTICE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...namespaced<LifecycleDenialCode>("lifecycle", LIFECYCLE_DENIAL_MESSAGES),
  "lifecycle.ACTOR_NOT_ACTIVE": ACTOR_NOT_ACTIVE_MESSAGE,
  ...namespaced<LegacyRevalidationCode>("revalidation", LEGACY_REVALIDATION_MESSAGES),
  ...namespaced<LifecycleStateErrorCode>("state", LIFECYCLE_STATE_MESSAGES),
  ...namespaced<ActionRefusalCode>("action", ACTION_REFUSAL_MESSAGES),
  ...namespaced<ReleaseRefusalCode>("release", RELEASE_REFUSAL_MESSAGES),
  "comment.INVALID": COMMENT_TOO_LONG_MESSAGE,
});

/** A notice code on the allowlist (branded so only validated codes flow on). */
export type NoticeCode = string & { readonly __notice: true };

/** Every allowlisted code (for tests and documentation). */
export function allNoticeCodes(): NoticeCode[] {
  return Object.keys(NOTICE_MESSAGES) as NoticeCode[];
}

function allowlisted(code: string): NoticeCode | null {
  return Object.prototype.hasOwnProperty.call(NOTICE_MESSAGES, code)
    ? (code as NoticeCode)
    : null;
}

/**
 * Validate the `notice` search parameter. Returns the code only when it is
 * exactly one allowlisted value; arrays, unknown values and anything else
 * return null and are ignored.
 */
export function parseNoticeCode(raw: unknown): NoticeCode | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  return allowlisted(raw);
}

/** The fixed message for an allowlisted code. */
export function noticeMessage(code: NoticeCode): string {
  return NOTICE_MESSAGES[code];
}

// ------------------------------------------------------------
// B06: naming a document in a notice WITHOUT reflecting request text
//
// The URL may carry, next to the notice code, the ID of the document the
// refusal is about (`doc`) and how many more documents are affected (`more`).
// Both are strictly validated. The page resolves the id to a document number
// ONLY among the signed-in user's own organization's documents; when that
// fails, the generic message is shown and the id itself is never rendered.
// ------------------------------------------------------------

/** The notice codes that may carry a subject document. */
const SUBJECT_NOTICE_CODES: ReadonlySet<string> = new Set(
  (Object.keys(RELEASE_REFUSAL_MESSAGES) as ReleaseRefusalCode[]).map((code) => `release.${code}`),
);

/** Server-generated ids (cuid) - letters, digits, '-' and '_' only. */
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SUBJECT_MORE_PATTERN = /^[0-9]{1,4}$/;

export interface NoticeSubject {
  cadDocumentId: string;
  /** How many OTHER documents are affected (0 = none). */
  more: number;
}

/** The subject of an expected refusal, when its notice can name a document. */
export function noticeSubjectOf(error: unknown): NoticeSubject | null {
  if (error instanceof ReleaseStructureIncompleteError) {
    return { cadDocumentId: error.cadDocumentId, more: Math.max(0, error.gapCount - 1) };
  }
  return null;
}

/** Validate the `doc` / `more` search parameters for an allowlisted code. */
export function parseNoticeSubject(code: NoticeCode, rawDoc: unknown, rawMore: unknown): NoticeSubject | null {
  if (!SUBJECT_NOTICE_CODES.has(code)) return null;
  if (typeof rawDoc !== "string" || !SUBJECT_ID_PATTERN.test(rawDoc)) return null;
  const more = typeof rawMore === "string" && SUBJECT_MORE_PATTERN.test(rawMore) ? Number(rawMore) : 0;
  return { cadDocumentId: rawDoc, more };
}

/**
 * The message for a notice. `subjectLabel` is the subject document's number,
 * looked up by the caller in the actor's own organization (null when there
 * is no subject or the lookup failed - then the fixed message is used).
 */
export function noticeMessageFor(
  code: NoticeCode,
  subject: { label: string | null; more: number } | null,
): string {
  if (subject !== null && subject.label !== null && SUBJECT_NOTICE_CODES.has(code)) {
    const releaseCode = code.slice("release.".length) as ReleaseRefusalCode;
    return namedReleaseMessage(releaseCode, subject.label, subject.more);
  }
  return NOTICE_MESSAGES[code];
}

/** Where a refused action sends the user: the dashboard with the code only
 *  (plus, for a subject-bearing notice, the validated subject id and count). */
export function noticeHref(code: NoticeCode, subject: NoticeSubject | null = null): string {
  const base = `/?notice=${encodeURIComponent(code)}`;
  if (subject === null || !SUBJECT_NOTICE_CODES.has(code) || !SUBJECT_ID_PATTERN.test(subject.cadDocumentId)) {
    return base;
  }
  const more = Number.isInteger(subject.more) && subject.more > 0 ? Math.min(subject.more, 9999) : 0;
  return `${base}&doc=${encodeURIComponent(subject.cadDocumentId)}${more > 0 ? `&more=${more}` : ""}`;
}

// ------------------------------------------------------------
// Classification
// ------------------------------------------------------------

/**
 * Map an error to an allowlisted notice code, or null when it is NOT an
 * expected refusal (the caller must then rethrow it unchanged).
 *
 * `LifecyclePermissionError` lives in release-db.ts (which needs the
 * database), so it is recognized by its stable `name` plus an allowlisted
 * `code`; errors are created only on the server, never from request data.
 */
export function classifyActionError(error: unknown): NoticeCode | null {
  if (isNextControlFlowError(error)) return null;
  if (!(error instanceof Error)) return null;

  if (error instanceof LegacyRevalidationError) {
    return allowlisted(`revalidation.${error.code}`);
  }
  if (error instanceof LifecycleStateError) {
    return allowlisted(`state.${error.code}`);
  }
  if (error instanceof ActionRefusalError) {
    return allowlisted(`action.${error.code}`);
  }
  if (error instanceof InvalidLifecycleCommentError) {
    return allowlisted("comment.INVALID");
  }
  if (error instanceof ReleaseStructureIncompleteError) {
    return allowlisted(`release.${RELEASE_CODE_FOR_GAP[error.kind]}`);
  }
  if (error.name === "LifecyclePermissionError") {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? allowlisted(`lifecycle.${code}`) : null;
  }
  return null;
}

/**
 * Run a Server Action body. Resolves to null on success, or to the notice
 * code of an EXPECTED refusal. Anything else is rethrown unchanged:
 * `rethrowFramework` (Next's `unstable_rethrow` in production code) runs
 * first, then the pure control-flow check, then the allowlist.
 *
 * The caller performs the redirect AFTER this resolves, outside any
 * try/catch, as Next.js requires.
 */
export async function runRefusable(
  run: () => Promise<unknown>,
  options: {
    classify?: (error: unknown) => NoticeCode | null;
    rethrowFramework?: (error: unknown) => void;
  } = {},
): Promise<NoticeCode | null> {
  const notice = await runRefusableNotice(run, options);
  return notice === null ? null : notice.code;
}

/**
 * B06: like `runRefusable`, but also returns the refusal's subject document
 * (if its notice can name one), for `noticeHref(code, subject)`.
 */
export async function runRefusableNotice(
  run: () => Promise<unknown>,
  options: {
    classify?: (error: unknown) => NoticeCode | null;
    rethrowFramework?: (error: unknown) => void;
  } = {},
): Promise<{ code: NoticeCode; subject: NoticeSubject | null } | null> {
  const classify = options.classify ?? classifyActionError;
  try {
    await run();
    return null;
  } catch (error) {
    options.rethrowFramework?.(error);
    if (isNextControlFlowError(error)) throw error;
    const code = classify(error);
    if (code === null) throw error;
    return { code, subject: noticeSubjectOf(error) };
  }
}

// ------------------------------------------------------------
// KI-1: sign-in
// ------------------------------------------------------------

/** The only accepted value of /login?error=... */
export const SIGN_IN_ERROR_PARAM = "signin";

/**
 * One message for every refused sign-in (unknown email, wrong password,
 * inactive account), so the page reveals nothing about which accounts exist.
 */
export const SIGN_IN_FAILED_MESSAGE = "Invalid email or password.";

/**
 * True only for Auth.js's refused-credentials error (`CredentialsSignin`,
 * raised when `authorize` returns null). Every other Auth.js error (for
 * example a configuration or database failure) and Next's success redirect
 * are NOT refusals and must propagate.
 */
export function isCredentialsSignInError(error: unknown): boolean {
  if (isNextControlFlowError(error)) return false;
  if (!(error instanceof Error)) return false;
  return (error as { type?: unknown }).type === "CredentialsSignin";
}

/** True only when /login?error= carries exactly the accepted value. */
export function isSignInErrorParam(raw: unknown): boolean {
  return raw === SIGN_IN_ERROR_PARAM;
}

/** Where a refused sign-in sends the user. */
export const SIGN_IN_REFUSED_HREF = `/login?error=${SIGN_IN_ERROR_PARAM}`;

/**
 * Run a sign-in attempt. Resolves to "refused" only for refused credentials.
 * A successful sign-in ends in Next's redirect, which - like every other
 * error - is rethrown unchanged (`rethrowFramework` first, then the pure
 * control-flow check). The caller redirects to SIGN_IN_REFUSED_HREF outside
 * any try/catch.
 */
export async function runSignInAttempt(
  run: () => Promise<unknown>,
  options: { rethrowFramework?: (error: unknown) => void } = {},
): Promise<"completed" | "refused"> {
  try {
    await run();
    return "completed";
  } catch (error) {
    options.rethrowFramework?.(error);
    if (isNextControlFlowError(error)) throw error;
    if (!isCredentialsSignInError(error)) throw error;
    return "refused";
  }
}
