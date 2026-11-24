/**
 * Arch PLM - B05: the notices of the /admin/users page.
 *
 * Same safety rules as the dashboard's notices (action-notice-core.ts): the
 * URL carries only a code; the page shows the fixed message for an
 * allowlisted code and ignores anything else, so no request text is ever
 * rendered. Kept separate from the dashboard's allowlist, because these
 * codes are shown only on /admin/users.
 *
 * Every outcome of an admin action becomes a notice, including an UNEXPECTED
 * error (Codex B05 L-1): the admin sees a fixed message instead of an error
 * page (HTTP 500), and the server log gets the error's name and code only -
 * never its message, which for a database error can quote the submitted
 * values (a password hash, an email address).
 *
 * Pure: no I/O, no Next.js imports.
 */
import { isNextControlFlowError, ActionRefusalError } from "./action-notice-core.ts";
import {
  USER_ADMIN_REFUSAL_MESSAGES,
  UserAdminRefusalError,
  type UserAdminRefusalCode,
} from "./user-admin-core.ts";

export type UserAdminSuccessCode =
  | "CREATED"
  | "ROLE_CHANGED"
  | "DEACTIVATED"
  | "REACTIVATED"
  | "PASSWORD_RESET"
  | "UNLOCKED"
  | "NOT_LOCKED";

const SUCCESS_MESSAGES: Record<UserAdminSuccessCode, string> = {
  CREATED: "User created. Give them their password in person.",
  ROLE_CHANGED: "Role changed. It applies from the user's next request.",
  DEACTIVATED: "User deactivated. Their web and CAD Connect sessions have ended.",
  REACTIVATED:
    "User reactivated with the new password. Give it to them in person; old sessions stay ended.",
  PASSWORD_RESET:
    "Password reset. Give the new password to the user in person; their existing sessions have ended.",
  UNLOCKED: "Sign-in unlocked. The user can sign in again now.",
  NOT_LOCKED: "That user's sign-in was not locked - nothing to unlock.",
};

const OTHER_MESSAGES = {
  CONCURRENT_CHANGES: "The change could not be saved because of concurrent changes. Please try again.",
  UNEXPECTED:
    "The change could not be completed because of a server error. Refresh the page to check the current state, then try again.",
} as const;

type OtherCode = keyof typeof OTHER_MESSAGES;

export type UserAdminNoticeKind = "success" | "refused";

interface NoticeEntry {
  kind: UserAdminNoticeKind;
  message: string;
}

const NOTICES: Readonly<Record<string, NoticeEntry>> = Object.freeze({
  ...Object.fromEntries(
    (Object.entries(SUCCESS_MESSAGES) as [UserAdminSuccessCode, string][]).map(([code, message]) => [
      `ok.${code}`,
      { kind: "success" as const, message },
    ]),
  ),
  ...Object.fromEntries(
    (Object.entries(USER_ADMIN_REFUSAL_MESSAGES) as [UserAdminRefusalCode, string][]).map(([code, message]) => [
      `refused.${code}`,
      { kind: "refused" as const, message },
    ]),
  ),
  ...Object.fromEntries(
    (Object.entries(OTHER_MESSAGES) as [OtherCode, string][]).map(([code, message]) => [
      `refused.${code}`,
      { kind: "refused" as const, message },
    ]),
  ),
});

/** An allowlisted /admin/users notice code (branded). */
export type UserAdminNoticeCode = string & { readonly __userAdminNotice: true };

export const USERS_PAGE_PATH = "/admin/users";

export function allUserAdminNoticeCodes(): UserAdminNoticeCode[] {
  return Object.keys(NOTICES) as UserAdminNoticeCode[];
}

/** Validate the `notice` search parameter: exactly one allowlisted value, else null. */
export function parseUserAdminNotice(raw: unknown): UserAdminNoticeCode | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  return Object.prototype.hasOwnProperty.call(NOTICES, raw) ? (raw as UserAdminNoticeCode) : null;
}

export function userAdminNotice(code: UserAdminNoticeCode): NoticeEntry {
  return NOTICES[code];
}

export function userAdminSuccessCode(code: UserAdminSuccessCode): UserAdminNoticeCode {
  return `ok.${code}` as UserAdminNoticeCode;
}

/** Where an admin action sends the user: the users page with the code only. */
export function userAdminNoticeHref(code: UserAdminNoticeCode): string {
  return `${USERS_PAGE_PATH}?notice=${encodeURIComponent(code)}`;
}

/** The notice for an expected refusal, or null when the error is not one. */
export function classifyUserAdminError(error: unknown): UserAdminNoticeCode | null {
  if (isNextControlFlowError(error)) return null;
  if (error instanceof UserAdminRefusalError) return `refused.${error.code}` as UserAdminNoticeCode;
  if (error instanceof ActionRefusalError && error.code === "CONCURRENT_CHANGES") {
    return "refused.CONCURRENT_CHANGES" as UserAdminNoticeCode;
  }
  return null;
}

/** Name and code of an unexpected error - never its message or stack. */
export function describeUnexpectedError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return `${name}${typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code) ? ` ${code}` : ""}`;
}

/**
 * Run one admin action body and return the notice to redirect to. Next.js
 * control flow (redirect etc.) is rethrown: `rethrowFramework` (Next's
 * `unstable_rethrow`) first, then the pure check. An expected refusal gives
 * its own notice; ANY other error gives the UNEXPECTED notice and one
 * server-log line from `describeUnexpectedError` (L-1).
 */
export async function runUserAdminAction<T>(
  run: () => Promise<T>,
  onSuccess: (value: T) => UserAdminNoticeCode,
  options: {
    rethrowFramework?: (error: unknown) => void;
    logUnexpected?: (line: string) => void;
  } = {},
): Promise<{ code: UserAdminNoticeCode; value: T | null }> {
  try {
    const value = await run();
    return { code: onSuccess(value), value };
  } catch (error) {
    options.rethrowFramework?.(error);
    if (isNextControlFlowError(error)) throw error;
    const refused = classifyUserAdminError(error);
    if (refused !== null) return { code: refused, value: null };
    (options.logUnexpected ?? ((line: string) => console.error(line)))(
      `user_admin action failed unexpectedly: ${describeUnexpectedError(error)}`,
    );
    return { code: "refused.UNEXPECTED" as UserAdminNoticeCode, value: null };
  }
}

/**
 * FE-L3: the refusals of "Create user" that the admin can correct in the form,
 * so the form is shown again with the typed email, name and role (never the
 * passwords). An explicit allowlist: every other outcome - above all the
 * authorization refusal USER_ADMIN_NOT_ADMIN (role revoked while the page was
 * open) and an UNEXPECTED server error - keeps the redirect to the guarded
 * users page.
 */
const CREATE_USER_CORRECTABLE: ReadonlySet<string> = new Set([
  "refused.USER_ADMIN_EMAIL_INVALID",
  "refused.USER_ADMIN_EMAIL_EXISTS",
  "refused.USER_ADMIN_NAME_INVALID",
  "refused.USER_ADMIN_ROLE_INVALID",
  "refused.USER_ADMIN_PASSWORD_TOO_SHORT",
  "refused.USER_ADMIN_PASSWORD_TOO_LONG",
  "refused.USER_ADMIN_PASSWORD_MISMATCH",
  "refused.CONCURRENT_CHANGES",
]);

export function isCreateUserCorrectableRefusal(code: UserAdminNoticeCode): boolean {
  return CREATE_USER_CORRECTABLE.has(code);
}
