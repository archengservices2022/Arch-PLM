/**
 * Arch PLM - B05 minimal user administration: database layer.
 *
 * PO-signed B05 plan Rev1, actions U1-U4 (U5 "unlock sign-in" follows in its
 * own commit). Deliberately no "server-only" and only type imports from the
 * generated client, so the plain Node test runner loads it with a fake db.
 *
 * RULES FOR EVERY ACTION (plan section 2, B05-M2)
 *  - The actor (id, organization, role) comes from getActor() - the session
 *    re-read from the database - never from FormData. A target user id from
 *    FormData is looked up ONLY within the actor's organization; another
 *    organization's id is "not found".
 *  - A non-ADMIN actor is refused before any input is validated or read.
 *  - Passwords are validated and hashed (bcrypt cost 12) BEFORE the
 *    transaction, so no row lock is held during the slow hash.
 *  - Inside ONE SERIALIZABLE transaction: FIRST lock the organization's
 *    active ADMIN rows FOR UPDATE in ascending id order (the actor's own row
 *    included), THEN re-check that the actor is one of them, THEN read and
 *    write. One lock covers both the actor-authority race (the actor demoted
 *    or deactivated while acting) and the last-active-admin rule (AC3).
 *  - Bounded retry on serialization conflicts; the final conflict is the
 *    CONCURRENT_CHANGES refusal.
 *  - G-1(a): exactly one structured log line per call - "committed" after the
 *    transaction commits, or "refused" with the refusal code. Ids, roles,
 *    flags and counts only; never an email, name, password or hash.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import { UserRole } from "../generated/prisma/enums.ts";
import { ActionRefusalError, retryOnSerializationConflict } from "./action-notice-core.ts";
import { isSerializationError } from "./db-concurrency-db.ts";
import {
  assertActorIsLockedAdmin,
  assertNotLastActiveAdmin,
  buildUserAdminLogEntry,
  logUserAdminEvent,
  normalizeEmail,
  normalizeName,
  parseRole,
  UserAdminRefusalError,
  validateNewPassword,
  type UserAdminAction,
  type UserAdminRefusalCode,
  type UserAdminLogEntry,
} from "./user-admin-core.ts";

export const BCRYPT_COST = 12;

/** The slice of PrismaClient this module needs. */
export type UserAdminDb = Pick<PrismaClient, "$transaction">;

export interface UserAdminActor {
  userId: string;
  organizationId: string;
  role: UserRole;
}

export interface UserAdminOptions {
  log?: (entry: UserAdminLogEntry) => void;
  now?: () => Date;
  /** bcrypt by default; injected by tests. */
  hashPassword?: (password: string) => Promise<string>;
  maxAttempts?: number;
}

async function bcryptHash(password: string): Promise<string> {
  const bcrypt = (await import("bcryptjs")).default;
  return bcrypt.hash(password, BCRYPT_COST);
}

const EXHAUSTED_MESSAGE =
  "The user change could not be saved because of concurrent changes. Please try again.";

type LogFields = Pick<
  UserAdminLogEntry,
  "targetUserId" | "oldRole" | "newRole" | "oldActive" | "newActive" | "desktopSessionsRevoked"
>;

const EMPTY_FIELDS: LogFields = {
  targetUserId: null,
  oldRole: null,
  newRole: null,
  oldActive: null,
  newActive: null,
  desktopSessionsRevoked: null,
};

// ------------------------------------------------------------
// Shared steps
// ------------------------------------------------------------

/**
 * Lock the organization's active ADMIN rows FOR UPDATE, ascending id.
 * Parameterised raw SQL - `${...}` values are bind parameters; 'ADMIN' is a
 * fixed literal (compared with the "UserRole" enum column).
 */
export async function lockActiveAdmins(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "User"
    WHERE "organizationId" = ${organizationId}
      AND "role" = 'ADMIN'
      AND "active" = true
    ORDER BY "id"
    FOR UPDATE
  `;
  return rows.map((row) => row.id);
}

/**
 * G-3(a): is the address taken anywhere - any organization, any letter case,
 * active or not? An address is refused when it equals an existing one
 * ignoring case, OR when either one, used as an ILIKE pattern, would match the
 * other ("_" and "%" are wildcards there). Sign-in itself has compared exactly
 * since SIGNIN-EXACT (sign-in-lookup-db.ts); the two ILIKE directions are kept
 * as the conservative rule reviewed for G-3, so any lookup that still uses
 * Prisma's case-insensitive equality (an ILIKE) stays unambiguous.
 * Run inside the SERIALIZABLE transaction: the scan takes a predicate lock,
 * so two concurrent creates of the same address cannot both commit.
 * (Codex L-3: a PRE-EXISTING stored address containing "%" would act as a
 * pattern here - impossible on the pilot database, where B05 refuses "%".)
 */
export async function emailTaken(tx: Prisma.TransactionClient, email: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "User"
    WHERE lower("email") = ${email}
       OR "email" ILIKE ${email}
       OR ${email} ILIKE "email"
    LIMIT 1
  `;
  return rows.length > 0;
}

async function findTarget(tx: Prisma.TransactionClient, organizationId: string, targetUserId: string) {
  const user = await tx.user.findFirst({
    where: { id: targetUserId, organizationId },
    select: { id: true, role: true, active: true },
  });
  if (user === null) throw new UserAdminRefusalError("USER_ADMIN_USER_NOT_FOUND");
  return user;
}

async function updateTarget(
  tx: Prisma.TransactionClient,
  organizationId: string,
  targetUserId: string,
  data: Prisma.UserUpdateManyMutationInput,
): Promise<void> {
  const updated = await tx.user.updateMany({ where: { id: targetUserId, organizationId }, data });
  if (updated.count !== 1) throw new UserAdminRefusalError("USER_ADMIN_USER_NOT_FOUND");
}

/** Revoke every not-yet-revoked desktop session of the user (AC2). */
async function revokeDesktopSessions(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  now: Date,
): Promise<number> {
  const revoked = await tx.desktopSession.updateMany({
    where: { organizationId, userId, revokedAt: null },
    data: { revokedAt: now },
  });
  return revoked.count;
}

function parseTargetId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    throw new UserAdminRefusalError("USER_ADMIN_USER_NOT_FOUND");
  }
  return raw;
}

/**
 * Run one admin action: role pre-check, the action's own preparation and
 * transaction (with retry), and exactly one log line.
 */
async function perform<T>(
  actor: UserAdminActor,
  action: UserAdminAction,
  db: UserAdminDb,
  options: UserAdminOptions,
  prepare: () => Promise<
    (tx: Prisma.TransactionClient, lockedAdminIds: string[], now: Date) => Promise<{ value: T; fields: LogFields }>
  >,
): Promise<T> {
  const now = (options.now ?? (() => new Date()))();
  const log = options.log ?? logUserAdminEvent;
  try {
    if (actor.role !== UserRole.ADMIN) throw new UserAdminRefusalError("USER_ADMIN_NOT_ADMIN");
    const body = await prepare();
    const { value, fields } = await retryOnSerializationConflict(
      () =>
        db.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const lockedAdminIds = await lockActiveAdmins(tx, actor.organizationId);
            assertActorIsLockedAdmin(actor.userId, lockedAdminIds);
            return body(tx, lockedAdminIds, now);
          },
          { isolationLevel: "Serializable" },
        ),
      { isConflict: isSerializationError, exhaustedMessage: EXHAUSTED_MESSAGE, maxAttempts: options.maxAttempts },
    );
    log(
      buildUserAdminLogEntry(
        {
          action,
          outcome: "committed",
          code: null,
          actorUserId: actor.userId,
          organizationId: actor.organizationId,
          ...fields,
        },
        now,
      ),
    );
    return value;
  } catch (error) {
    const code =
      error instanceof UserAdminRefusalError
        ? error.code
        : error instanceof ActionRefusalError && error.code === "CONCURRENT_CHANGES"
          ? "CONCURRENT_CHANGES"
          : null;
    if (code !== null) {
      log(
        buildUserAdminLogEntry(
          {
            action,
            outcome: "refused",
            code,
            actorUserId: actor.userId,
            organizationId: actor.organizationId,
            ...EMPTY_FIELDS,
            targetUserId: error instanceof UserAdminRefusalError ? error.targetUserId : null,
          },
          now,
        ),
      );
    }
    throw error;
  }
}

/** A refusal raised once the target is known (its id goes into the log line). */
function refuse(code: UserAdminRefusalCode, targetUserId: string): never {
  throw new UserAdminRefusalError(code, targetUserId);
}

// ------------------------------------------------------------
// U1 create user
// ------------------------------------------------------------

export interface CreateUserInput {
  email: unknown;
  name: unknown;
  role: unknown;
  password: unknown;
  passwordConfirmation: unknown;
}

export async function createUserForAdmin(
  actor: UserAdminActor,
  input: CreateUserInput,
  db: UserAdminDb,
  options: UserAdminOptions = {},
): Promise<{ userId: string }> {
  return perform(actor, "create_user", db, options, async () => {
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const role = parseRole(input.role);
    const password = validateNewPassword(input.password, input.passwordConfirmation);
    const passwordHash = await (options.hashPassword ?? bcryptHash)(password);
    return async (tx) => {
      if (await emailTaken(tx, email)) throw new UserAdminRefusalError("USER_ADMIN_EMAIL_EXISTS");
      let created: { id: string };
      try {
        created = await tx.user.create({
          data: { organizationId: actor.organizationId, email, name, role, passwordHash, active: true },
          select: { id: true },
        });
      } catch (error) {
        // (organizationId, email) unique - a row the check above did not see.
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002") {
          throw new UserAdminRefusalError("USER_ADMIN_EMAIL_EXISTS");
        }
        throw error;
      }
      return {
        value: { userId: created.id },
        fields: { ...EMPTY_FIELDS, targetUserId: created.id, newRole: role, newActive: true },
      };
    };
  });
}

// ------------------------------------------------------------
// U2 change role
// ------------------------------------------------------------

export async function changeUserRoleForAdmin(
  actor: UserAdminActor,
  rawTargetUserId: unknown,
  rawRole: unknown,
  db: UserAdminDb,
  options: UserAdminOptions = {},
): Promise<void> {
  return perform(actor, "change_role", db, options, async () => {
    const targetUserId = parseTargetId(rawTargetUserId);
    const newRole = parseRole(rawRole);
    if (targetUserId === actor.userId) refuse("USER_ADMIN_SELF_ROLE", targetUserId);
    return async (tx, lockedAdminIds) => {
      const target = await findTarget(tx, actor.organizationId, targetUserId);
      if (target.role === newRole) refuse("USER_ADMIN_NO_CHANGE", target.id);
      if (newRole !== UserRole.ADMIN) assertNotLastActiveAdmin(target.id, lockedAdminIds);
      await updateTarget(tx, actor.organizationId, target.id, { role: newRole });
      return {
        value: undefined,
        fields: { ...EMPTY_FIELDS, targetUserId: target.id, oldRole: target.role, newRole },
      };
    };
  });
}

// ------------------------------------------------------------
// U3 deactivate / reactivate
// ------------------------------------------------------------

/** The value the deactivation form's confirmation checkbox must send. */
export const DEACTIVATE_CONFIRMATION_VALUE = "yes";

/**
 * Deactivation needs an explicit confirmation (Codex C2-L2): undoing it means a
 * reactivation with a new password handed over in person. Checked after the
 * role pre-check, so a non-admin is still refused (and logged) as NOT_ADMIN.
 */
export async function deactivateUserForAdmin(
  actor: UserAdminActor,
  rawTargetUserId: unknown,
  confirmation: unknown,
  db: UserAdminDb,
  options: UserAdminOptions = {},
): Promise<{ desktopSessionsRevoked: number }> {
  return perform(actor, "deactivate_user", db, options, async () => {
    const targetUserId = parseTargetId(rawTargetUserId);
    if (targetUserId === actor.userId) refuse("USER_ADMIN_SELF_DEACTIVATE", targetUserId);
    if (confirmation !== DEACTIVATE_CONFIRMATION_VALUE) refuse("USER_ADMIN_CONFIRM_REQUIRED", targetUserId);
    return async (tx, lockedAdminIds, now) => {
      const target = await findTarget(tx, actor.organizationId, targetUserId);
      if (!target.active) refuse("USER_ADMIN_NO_CHANGE", target.id);
      assertNotLastActiveAdmin(target.id, lockedAdminIds);
      await updateTarget(tx, actor.organizationId, target.id, { active: false });
      const revoked = await revokeDesktopSessions(tx, actor.organizationId, target.id, now);
      return {
        value: { desktopSessionsRevoked: revoked },
        fields: {
          ...EMPTY_FIELDS,
          targetUserId: target.id,
          oldActive: true,
          newActive: false,
          desktopSessionsRevoked: revoked,
        },
      };
    };
  });
}

/** Reactivation REQUIRES a new password (B05-M1): old web sessions fail the
 *  pwv check and old desktop sessions stay revoked. */
export async function reactivateUserForAdmin(
  actor: UserAdminActor,
  rawTargetUserId: unknown,
  password: unknown,
  passwordConfirmation: unknown,
  db: UserAdminDb,
  options: UserAdminOptions = {},
): Promise<{ desktopSessionsRevoked: number }> {
  return perform(actor, "reactivate_user", db, options, async () => {
    const targetUserId = parseTargetId(rawTargetUserId);
    const newPassword = validateNewPassword(password, passwordConfirmation);
    const passwordHash = await (options.hashPassword ?? bcryptHash)(newPassword);
    return async (tx, _lockedAdminIds, now) => {
      const target = await findTarget(tx, actor.organizationId, targetUserId);
      if (target.active) refuse("USER_ADMIN_USER_ACTIVE", target.id);
      await updateTarget(tx, actor.organizationId, target.id, { active: true, passwordHash });
      // Defence in depth: deactivation already revoked them.
      const revoked = await revokeDesktopSessions(tx, actor.organizationId, target.id, now);
      return {
        value: { desktopSessionsRevoked: revoked },
        fields: {
          ...EMPTY_FIELDS,
          targetUserId: target.id,
          oldActive: false,
          newActive: true,
          desktopSessionsRevoked: revoked,
        },
      };
    };
  });
}

// ------------------------------------------------------------
// U4 reset password
// ------------------------------------------------------------

/**
 * Sets a new password typed by the admin (G-2(a)); revokes the user's desktop
 * sessions and - through pwv (G-6(a)) - ends their web sessions on the next
 * request. `selfReset` tells the caller the actor reset their own password,
 * so their own web session has just ended too (Codex B05 I-2).
 */
export async function resetUserPasswordForAdmin(
  actor: UserAdminActor,
  rawTargetUserId: unknown,
  password: unknown,
  passwordConfirmation: unknown,
  db: UserAdminDb,
  options: UserAdminOptions = {},
): Promise<{ desktopSessionsRevoked: number; selfReset: boolean }> {
  return perform(actor, "reset_password", db, options, async () => {
    const targetUserId = parseTargetId(rawTargetUserId);
    const newPassword = validateNewPassword(password, passwordConfirmation);
    const passwordHash = await (options.hashPassword ?? bcryptHash)(newPassword);
    return async (tx, _lockedAdminIds, now) => {
      const target = await findTarget(tx, actor.organizationId, targetUserId);
      if (!target.active) refuse("USER_ADMIN_USER_INACTIVE", target.id);
      await updateTarget(tx, actor.organizationId, target.id, { passwordHash });
      const revoked = await revokeDesktopSessions(tx, actor.organizationId, target.id, now);
      return {
        value: { desktopSessionsRevoked: revoked, selfReset: target.id === actor.userId },
        fields: { ...EMPTY_FIELDS, targetUserId: target.id, desktopSessionsRevoked: revoked },
      };
    };
  });
}
