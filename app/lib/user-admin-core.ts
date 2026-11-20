/**
 * Arch PLM - B05 minimal user administration: pure rules.
 *
 * PO-signed B05 plan Rev1 (821D1013...24C3 unsigned text), decisions G-1(a) to
 * G-6(a). This module holds every rule that needs no database:
 *   - input validation (email, name, role, password) - plan section 2;
 *   - the last-active-admin and self-protection rules (AC3, B05-M2);
 *   - the password-version claim `pwv` that ends web sessions on a password
 *     change (G-6(a), B05-M1);
 *   - the shape of the one structured log line per admin action (G-1(a)).
 *
 * Pure: no I/O, no Prisma, no "server-only" (only node:crypto), so the plain
 * Node test runner loads it.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { UserRole } from "../generated/prisma/enums.ts";

// ------------------------------------------------------------
// Refusals
// ------------------------------------------------------------

export type UserAdminRefusalCode =
  | "USER_ADMIN_NOT_ADMIN"
  | "USER_ADMIN_USER_NOT_FOUND"
  | "USER_ADMIN_EMAIL_INVALID"
  | "USER_ADMIN_EMAIL_EXISTS"
  | "USER_ADMIN_NAME_INVALID"
  | "USER_ADMIN_ROLE_INVALID"
  | "USER_ADMIN_PASSWORD_TOO_SHORT"
  | "USER_ADMIN_PASSWORD_TOO_LONG"
  | "USER_ADMIN_PASSWORD_MISMATCH"
  | "USER_ADMIN_SELF_DEACTIVATE"
  | "USER_ADMIN_SELF_ROLE"
  | "USER_ADMIN_LAST_ADMIN"
  | "USER_ADMIN_NO_CHANGE"
  | "USER_ADMIN_USER_INACTIVE"
  | "USER_ADMIN_USER_ACTIVE"
  | "USER_ADMIN_CONFIRM_REQUIRED";

export const USER_ADMIN_REFUSAL_MESSAGES: Record<UserAdminRefusalCode, string> = {
  USER_ADMIN_NOT_ADMIN: "Only an administrator can manage users.",
  USER_ADMIN_USER_NOT_FOUND: "That user was not found. Refresh the page and try again.",
  USER_ADMIN_EMAIL_INVALID:
    "Enter a valid email address (plain ASCII, no spaces, % or \\; at most 254 characters).",
  // Codex B05 INFO: "_" is compared as a sign-in wildcard too, so "a_b@x" and
  // "axb@x" cannot both exist (a deliberate, conservative refusal).
  USER_ADMIN_EMAIL_EXISTS:
    "A user with that email address - or one that differs only where this address has an underscore (_) - already exists.",
  USER_ADMIN_NAME_INVALID:
    "Enter a name of 1 to 100 characters (no control or text-direction characters).",
  USER_ADMIN_ROLE_INVALID: "Choose one of the listed roles.",
  USER_ADMIN_PASSWORD_TOO_SHORT: "The password is too short.",
  USER_ADMIN_PASSWORD_TOO_LONG: "The password is too long (at most 72 bytes).",
  USER_ADMIN_PASSWORD_MISMATCH: "The two passwords do not match.",
  USER_ADMIN_SELF_DEACTIVATE: "You cannot deactivate your own account.",
  USER_ADMIN_SELF_ROLE: "You cannot change your own role.",
  USER_ADMIN_LAST_ADMIN:
    "This would leave the organization without an active administrator.",
  USER_ADMIN_NO_CHANGE: "Nothing to change - the user already has that setting.",
  USER_ADMIN_USER_INACTIVE:
    "That user is deactivated. Reactivate the user instead (that sets a new password).",
  USER_ADMIN_USER_ACTIVE: "That user is already active.",
  USER_ADMIN_CONFIRM_REQUIRED:
    "Tick the confirmation box to deactivate the user (reactivating later needs a new password).",
};

/** An expected refusal of a user-administration action. Carries only a code,
 *  the fixed message and (for the G-1 log line) the target user id once it is
 *  known - never any submitted value. */
export class UserAdminRefusalError extends Error {
  readonly code: UserAdminRefusalCode;
  readonly targetUserId: string | null;
  constructor(code: UserAdminRefusalCode, targetUserId: string | null = null) {
    super(USER_ADMIN_REFUSAL_MESSAGES[code]);
    this.name = "UserAdminRefusalError";
    this.code = code;
    this.targetUserId = targetUserId;
  }
}

// ------------------------------------------------------------
// Input validation (plan section 2, "Input limits")
// ------------------------------------------------------------

export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 100;
export const MIN_PASSWORD_CHARS = 12;
export const MIN_FIRST_ADMIN_PASSWORD_CHARS = 16;
/** bcrypt silently ignores input beyond 72 bytes - refuse it instead. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Plain ASCII address: one "@", a non-empty local part and a dotted domain.
 * Deliberately excludes "%" and "\" (and every other character outside the
 * list): Prisma's case-insensitive equality on PostgreSQL is an ILIKE, where
 * "%" is a wildcard and "\" the escape character (B05 G-3). "_" - also an
 * ILIKE wildcard - is allowed because real addresses use it; the duplicate
 * check compares in both directions to cover it (user-admin-db.ts).
 */
const EMAIL_PATTERN =
  /^[a-z0-9.!#$&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Trim + lower-case + validate. Throws USER_ADMIN_EMAIL_INVALID. */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new UserAdminRefusalError("USER_ADMIN_EMAIL_INVALID");
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new UserAdminRefusalError("USER_ADMIN_EMAIL_INVALID");
  }
  return email;
}

/** Control characters, and the bidirectional overrides / isolates / marks
 *  that could make a name look like another user's in a list (Codex B05 L-2),
 *  plus zero-width characters, the Arabic letter mark and the BOM (C2-L1).
 *  Written as \u escapes on purpose: literal invisible characters cannot be reviewed. */
const FORBIDDEN_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** Trimmed display name of 1-100 characters (code points). */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new UserAdminRefusalError("USER_ADMIN_NAME_INVALID");
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_LENGTH || FORBIDDEN_NAME_CHARACTERS.test(name)) {
    throw new UserAdminRefusalError("USER_ADMIN_NAME_INVALID");
  }
  return name;
}

const ROLES: readonly UserRole[] = Object.values(UserRole);

/** One of the six roles, exactly as spelled in the enum. */
export function parseRole(raw: unknown): UserRole {
  if (typeof raw !== "string" || !(ROLES as readonly string[]).includes(raw)) {
    throw new UserAdminRefusalError("USER_ADMIN_ROLE_INVALID");
  }
  return raw as UserRole;
}

/**
 * Validate a new password typed twice. Length is counted in characters (code
 * points) for the minimum and in UTF-8 bytes for the bcrypt maximum. The
 * password is never trimmed, logged or returned in an error.
 */
export function validateNewPassword(
  password: unknown,
  confirmation: unknown,
  minChars: number = MIN_PASSWORD_CHARS,
): string {
  if (typeof password !== "string" || [...password].length < minChars) {
    throw new UserAdminRefusalError("USER_ADMIN_PASSWORD_TOO_SHORT");
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new UserAdminRefusalError("USER_ADMIN_PASSWORD_TOO_LONG");
  }
  if (typeof confirmation !== "string" || confirmation !== password) {
    throw new UserAdminRefusalError("USER_ADMIN_PASSWORD_MISMATCH");
  }
  return password;
}

// ------------------------------------------------------------
// Authority, self-protection and the last active admin (AC3, B05-M2)
// ------------------------------------------------------------

/**
 * After the organization's active ADMIN rows are locked: the actor must be
 * one of them (re-checked from the database - the session is not enough).
 */
export function assertActorIsLockedAdmin(actorUserId: string, lockedAdminIds: readonly string[]): void {
  if (!lockedAdminIds.includes(actorUserId)) {
    throw new UserAdminRefusalError("USER_ADMIN_NOT_ADMIN");
  }
}

/**
 * Would removing `targetUserId` from the locked active admins (deactivation or
 * demotion) leave none? A target that is not an active admin removes nothing.
 */
export function assertNotLastActiveAdmin(targetUserId: string, lockedAdminIds: readonly string[]): void {
  if (lockedAdminIds.includes(targetUserId) && lockedAdminIds.length <= 1) {
    throw new UserAdminRefusalError("USER_ADMIN_LAST_ADMIN", targetUserId);
  }
}

// ------------------------------------------------------------
// Password version (G-6(a))
// ------------------------------------------------------------

export const PASSWORD_VERSION_HEX_LENGTH = 16;

/**
 * `pwv` = the first 16 hex characters of sha256(passwordHash). Changes
 * whenever the bcrypt hash changes (every reset / reactivation produces a new
 * salt). Null for a user without a password (cannot sign in anyway).
 */
export function passwordVersion(passwordHash: string | null | undefined): string | null {
  if (typeof passwordHash !== "string" || passwordHash.length === 0) return null;
  return createHash("sha256")
    .update(passwordHash, "utf8")
    .digest("hex")
    .slice(0, PASSWORD_VERSION_HEX_LENGTH);
}

/**
 * Does the session's `pwv` match the user's current password hash? A missing
 * or malformed claim never matches (a token issued before B05 is refused, so
 * every user signs in once after the deployment - G-6(a)).
 */
export function passwordVersionMatches(
  claim: unknown,
  currentPasswordHash: string | null | undefined,
): boolean {
  const current = passwordVersion(currentPasswordHash);
  if (current === null || typeof claim !== "string" || claim.length !== current.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(claim, "utf8"), Buffer.from(current, "utf8"));
}

// ------------------------------------------------------------
// The one log line per admin action (G-1(a))
// ------------------------------------------------------------

export const USER_ADMIN_EVENT = "user_admin" as const;

export type UserAdminAction =
  | "create_user"
  | "change_role"
  | "deactivate_user"
  | "reactivate_user"
  | "reset_password"
  | "unlock_sign_in";

export interface UserAdminLogEntry {
  event: typeof USER_ADMIN_EVENT;
  action: UserAdminAction;
  outcome: "committed" | "refused";
  /** Refusal code, or null when committed. */
  code: UserAdminRefusalCode | "CONCURRENT_CHANGES" | null;
  actorUserId: string;
  organizationId: string;
  /** Null when the target is unknown (refused before it was found, or create refused). */
  targetUserId: string | null;
  oldRole: UserRole | null;
  newRole: UserRole | null;
  oldActive: boolean | null;
  newActive: boolean | null;
  /** Desktop sessions revoked in the same transaction (deactivate / reactivate / reset). */
  desktopSessionsRevoked: number | null;
  at: string;
}

/**
 * Build a log entry from an explicit allowlist of fields. Ids, roles, flags
 * and counts only - there is no field for an email, name, password or hash.
 */
export function buildUserAdminLogEntry(
  fields: Omit<UserAdminLogEntry, "event" | "at">,
  now: Date,
): UserAdminLogEntry {
  return {
    event: USER_ADMIN_EVENT,
    action: fields.action,
    outcome: fields.outcome,
    code: fields.code,
    actorUserId: fields.actorUserId,
    organizationId: fields.organizationId,
    targetUserId: fields.targetUserId,
    oldRole: fields.oldRole,
    newRole: fields.newRole,
    oldActive: fields.oldActive,
    newActive: fields.newActive,
    desktopSessionsRevoked: fields.desktopSessionsRevoked,
    at: now.toISOString(),
  };
}

/** Default sink: one JSON line on the server log (the durable file and its
 *  retention are set up by the deployment - A1 Rev4, PD-17). */
export function logUserAdminEvent(entry: UserAdminLogEntry): void {
  console.info(JSON.stringify(entry));
}
