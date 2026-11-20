/**
 * Arch PLM - B05 G-5(a): create the FIRST administrator on the pilot database.
 *
 * Used only by scripts/create-first-admin.ts (run once by the operator under
 * the A-ENV go, through scripts/create-first-admin.ps1). prisma/seed.ts stays
 * unused for the pilot.
 *
 * RULES (PO-signed B05 plan Rev1, G-5(a); Codex B05 I-3)
 *  - REFUSES when an active ADMIN exists in ANY organization (a fresh,
 *    single-organization pilot database is expected).
 *  - REFUSES when the email is taken anywhere - the same G-3 rule as U1
 *    (emailTaken: any organization, any letter case, inactive included).
 *  - Uses the organization with the given code if it exists AND has the same
 *    name; refuses a code that exists under another name; otherwise creates
 *    the organization.
 *  - NEVER updates an existing user (unlike prisma/seed.ts).
 *  - Password at least 16 characters and at most 72 UTF-8 bytes, typed twice.
 *  - Everything in ONE SERIALIZABLE transaction with bounded retry, so two
 *    concurrent runs cannot both create an administrator.
 *  - DRY RUN: every check (input, existing admin, email, organization) runs
 *    and is reported, but nothing is hashed or written.
 *  - Returns the G-1 log entry for the evidence log (ids only); the password
 *    and hash never leave this module.
 *
 * No "server-only" and only type imports from the generated client, so the
 * plain Node test runner loads it with a fake db.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import { UserRole } from "../generated/prisma/enums.ts";
import { retryOnSerializationConflict } from "./action-notice-core.ts";
import { isSerializationError } from "./db-concurrency-db.ts";
import { normalizeOrganizationCode } from "./first-admin-core.ts";
import {
  buildUserAdminLogEntry,
  MIN_FIRST_ADMIN_PASSWORD_CHARS,
  normalizeEmail,
  normalizeName,
  validateNewPassword,
  type UserAdminLogEntry,
} from "./user-admin-core.ts";
import { BCRYPT_COST, emailTaken } from "./user-admin-db.ts";

export type FirstAdminDb = Pick<PrismaClient, "$transaction">;

export type FirstAdminRefusalCode =
  | "FIRST_ADMIN_ADMIN_EXISTS"
  | "FIRST_ADMIN_EMAIL_EXISTS"
  | "FIRST_ADMIN_ORG_NAME_MISMATCH";

export const FIRST_ADMIN_REFUSAL_MESSAGES: Record<FirstAdminRefusalCode, string> = {
  FIRST_ADMIN_ADMIN_EXISTS:
    "Refused: an active administrator already exists in this database. Use the Users page instead.",
  FIRST_ADMIN_EMAIL_EXISTS: "Refused: a user with that email address already exists in this database.",
  FIRST_ADMIN_ORG_NAME_MISMATCH:
    "Refused: an organization with that code already exists under a different name.",
};

export class FirstAdminRefusalError extends Error {
  readonly code: FirstAdminRefusalCode;
  constructor(code: FirstAdminRefusalCode) {
    super(FIRST_ADMIN_REFUSAL_MESSAGES[code]);
    this.name = "FirstAdminRefusalError";
    this.code = code;
  }
}

/** The script's own actor id in the G-1 log line (there is no user yet). */
export const FIRST_ADMIN_SCRIPT_ACTOR = "script:create-first-admin";

export interface FirstAdminInput {
  email: unknown;
  name: unknown;
  organizationName: unknown;
  organizationCode: string;
  password: unknown;
  passwordConfirmation: unknown;
}

export type FirstAdminResult =
  | {
      outcome: "dry-run";
      email: string;
      organizationCode: string;
      organizationExists: boolean;
    }
  | {
      outcome: "created";
      email: string;
      organizationCode: string;
      organizationId: string;
      organizationCreated: boolean;
      userId: string;
      log: UserAdminLogEntry;
    };

async function bcryptHash(password: string): Promise<string> {
  const bcrypt = (await import("bcryptjs")).default;
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function createFirstAdmin(
  input: FirstAdminInput,
  db: FirstAdminDb,
  options: {
    dryRun?: boolean;
    hashPassword?: (password: string) => Promise<string>;
    now?: () => Date;
    maxAttempts?: number;
  } = {},
): Promise<FirstAdminResult> {
  // Input first - nothing is read before it is valid.
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);
  const organizationName = normalizeName(input.organizationName);
  const organizationCode = normalizeOrganizationCode(input.organizationCode);
  const password = validateNewPassword(input.password, input.passwordConfirmation, MIN_FIRST_ADMIN_PASSWORD_CHARS);
  const dryRun = options.dryRun === true;
  const passwordHash = dryRun ? null : await (options.hashPassword ?? bcryptHash)(password);

  const outcome = await retryOnSerializationConflict(
    () =>
      db.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const admin = await tx.user.findFirst({
            where: { role: UserRole.ADMIN, active: true },
            select: { id: true },
          });
          if (admin !== null) throw new FirstAdminRefusalError("FIRST_ADMIN_ADMIN_EXISTS");
          if (await emailTaken(tx, email)) throw new FirstAdminRefusalError("FIRST_ADMIN_EMAIL_EXISTS");
          const organization = await tx.organization.findUnique({
            where: { code: organizationCode },
            select: { id: true, name: true },
          });
          if (organization !== null && organization.name !== organizationName) {
            throw new FirstAdminRefusalError("FIRST_ADMIN_ORG_NAME_MISMATCH");
          }
          if (dryRun || passwordHash === null) {
            return { kind: "dry-run" as const, organizationExists: organization !== null };
          }
          const organizationId =
            organization?.id ??
            (
              await tx.organization.create({
                data: { name: organizationName, code: organizationCode },
                select: { id: true },
              })
            ).id;
          const user = await tx.user.create({
            data: { organizationId, email, name, role: UserRole.ADMIN, passwordHash, active: true },
            select: { id: true },
          });
          return {
            kind: "created" as const,
            organizationId,
            organizationCreated: organization === null,
            userId: user.id,
          };
        },
        { isolationLevel: "Serializable" },
      ),
    {
      isConflict: isSerializationError,
      exhaustedMessage: "The first administrator could not be created because of concurrent changes. Run it again.",
      maxAttempts: options.maxAttempts,
    },
  );

  if (outcome.kind === "dry-run") {
    return { outcome: "dry-run", email, organizationCode, organizationExists: outcome.organizationExists };
  }
  const log = buildUserAdminLogEntry(
    {
      action: "create_first_admin",
      outcome: "committed",
      code: null,
      actorUserId: FIRST_ADMIN_SCRIPT_ACTOR,
      organizationId: outcome.organizationId,
      targetUserId: outcome.userId,
      oldRole: null,
      newRole: UserRole.ADMIN,
      oldActive: null,
      newActive: true,
      desktopSessionsRevoked: null,
    },
    (options.now ?? (() => new Date()))(),
  );
  return {
    outcome: "created",
    email,
    organizationCode,
    organizationId: outcome.organizationId,
    organizationCreated: outcome.organizationCreated,
    userId: outcome.userId,
    log,
  };
}
