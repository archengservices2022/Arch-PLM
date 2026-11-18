/**
 * Arch PLM - desktop bearer-session Prisma wiring (P4A).
 *
 * Deliberately does NOT import "server-only" and takes `db` as a required
 * parameter, mirroring `get-latest-db.ts` / `release-db.ts` /
 * `released-workspace-db.ts` - so the plain Node test runner can exercise it
 * with an in-memory fake. Only `Actor` and `PrismaClient` are imported, and
 * only as types (erased at compile). `bcryptjs` is a pure JS dependency and
 * loads fine under the test runner (the same package `auth.ts` uses).
 *
 * The server-only entry point is `app/lib/desktop-auth.ts`, a thin shim that
 * supplies the real `prisma` client.
 *
 * TENANT RULE (identical to `authz.ts`): the authenticated `DesktopSession`
 * row is the ONLY source of `organizationId` / `userId` / `role`. Nothing a
 * desktop client sends is ever trusted for identity. Every resolution
 * re-checks the `User` row (`active`, org match) exactly as `getActor`.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import type { Actor } from "@/app/lib/authz";
import bcrypt from "bcryptjs";

import {
  DESKTOP_AUTH_CONTRACT,
  DESKTOP_SESSION_TOUCH_INTERVAL_MS,
  DesktopAuthError,
  evaluateDesktopSession,
  generateDesktopToken,
  hashDesktopToken,
  resolveDesktopSessionTtlHours,
  sanitizeClientLabel,
  type DesktopIdentityDto,
  type DesktopLoginResponseDto,
  type DesktopSessionResponseDto,
} from "./desktop-auth-core.ts";
import {
  getSharedLoginThrottle,
  loginThrottleKey,
  type LoginThrottle,
} from "./login-throttle-core.ts";

export { DesktopAuthError };

/**
 * WP-2A (2A-1): too many failed sign-ins for this account - a controlled 429
 * with a Retry-After value. The message stays generic (it never says whether
 * the account exists) and the password is not checked while refused.
 */
export class DesktopLoginThrottledError extends DesktopAuthError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(429, "Too many failed sign-in attempts. Wait a few minutes and try again.");
    this.name = "DesktopLoginThrottledError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The slice of PrismaClient this module needs. */
export type DesktopAuthDb = Pick<PrismaClient, "user" | "desktopSession">;

const GENERIC_CREDENTIAL_ERROR =
  "Sign-in failed. Check the email and password and try again.";

interface AuthedUserRow {
  id: string;
  organizationId: string;
  role: Actor["role"];
  name: string;
  email: string;
  passwordHash: string | null;
  active: boolean;
  organization: { id: string; code: string; name: string };
}

function identityOf(user: AuthedUserRow): DesktopIdentityDto {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: String(user.role),
    organization: user.organization,
  };
}

/**
 * Verify email + password and mint a `DesktopSession`. Returns the raw token
 * ONCE. Any credential problem - unknown email, wrong password, inactive
 * user, missing hash - throws the SAME generic `DesktopAuthError(401)`.
 *
 * A bcrypt comparison is always performed (against a dummy hash when the
 * user does not exist) so response timing does not reveal whether an email
 * is registered.
 *
 * WP-2A (2A-1): sign-ins are throttled per account (shared with the browser
 * sign-in). While an account is refused, `DesktopLoginThrottledError` (429)
 * is thrown BEFORE any lookup or password check; every credential failure is
 * recorded; a success clears the record. `opts.throttle` exists for tests -
 * production always uses the shared process-wide instance.
 */
export async function authenticateDesktopClient(
  email: unknown,
  password: unknown,
  clientLabelInput: unknown,
  db: DesktopAuthDb,
  opts: { ttlHours?: number; now?: Date; throttle?: LoginThrottle } = {},
): Promise<DesktopLoginResponseDto> {
  if (typeof email !== "string" || typeof password !== "string") {
    throw new DesktopAuthError(400, "email and password are required.");
  }
  const normalizedEmail = email.trim().toLowerCase();

  const throttle = opts.throttle ?? getSharedLoginThrottle();
  const throttleKey = loginThrottleKey(normalizedEmail);
  // Reserve the attempt BEFORE any await (Codex WP2A-H1).
  const decision = throttle.beginAttempt(throttleKey);
  if (!decision.allowed) {
    throw new DesktopLoginThrottledError(decision.retryAfterSeconds);
  }

  let user: AuthedUserRow | null;
  let passwordOk: boolean;
  try {
    user = (await db.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      select: {
        id: true,
        organizationId: true,
        role: true,
        name: true,
        email: true,
        passwordHash: true,
        active: true,
        organization: { select: { id: true, code: true, name: true } },
      },
    })) as AuthedUserRow | null;

    // Constant-ish work whether or not the user exists.
    const hashToCompare =
      user?.passwordHash ??
      "$2a$12$0000000000000000000000000000000000000000000000000000a";
    passwordOk = await bcrypt.compare(password, hashToCompare);
  } catch (error) {
    // No verdict about the password: release the reservation.
    throttle.cancelAttempt(throttleKey);
    throw error;
  }

  if (!user || !user.passwordHash || !user.active || !passwordOk) {
    throttle.recordFailure(throttleKey);
    throw new DesktopAuthError(401, GENERIC_CREDENTIAL_ERROR);
  }
  throttle.recordSuccess(throttleKey);

  const now = opts.now ?? new Date();
  const ttlHours = opts.ttlHours ?? resolveDesktopSessionTtlHours();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  const { token, tokenHash } = generateDesktopToken();

  await db.desktopSession.create({
    data: {
      organizationId: user.organizationId,
      userId: user.id,
      tokenHash,
      clientLabel: sanitizeClientLabel(clientLabelInput),
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
    },
  });

  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: now },
  });

  return {
    contract: DESKTOP_AUTH_CONTRACT,
    tokenType: "Bearer",
    token,
    expiresAt: expiresAt.toISOString(),
    identity: identityOf(user),
  };
}

export interface ResolvedDesktopSession {
  actor: Actor;
  identity: DesktopIdentityDto;
  session: { createdAt: Date; expiresAt: Date; lastUsedAt: Date };
}

/**
 * Resolve a raw bearer token to an `Actor` (+ display identity + session
 * timing). Enforces: session exists, not revoked, not expired, and the named
 * user is still active and still in the session's organization. Returns null
 * on ANY failure - callers surface a generic 401, never a reason.
 *
 * Best-effort `lastUsedAt` touch, throttled by
 * `DESKTOP_SESSION_TOUCH_INTERVAL_MS`; a touch failure never fails the call.
 */
export async function resolveDesktopSession(
  rawToken: string,
  db: DesktopAuthDb,
  now: Date = new Date(),
): Promise<ResolvedDesktopSession | null> {
  const tokenHash = hashDesktopToken(rawToken);

  const row = await db.desktopSession.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });

  const verdict = evaluateDesktopSession(
    row ? { createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt } : null,
    now,
  );
  if (!verdict.ok || !row) {
    return null;
  }

  const user = (await db.user.findFirst({
    where: { id: row.userId, active: true },
    select: {
      id: true,
      organizationId: true,
      role: true,
      name: true,
      email: true,
      passwordHash: true,
      active: true,
      organization: { select: { id: true, code: true, name: true } },
    },
  })) as AuthedUserRow | null;

  if (!user || user.organizationId !== row.organizationId) {
    return null;
  }

  if (now.getTime() - row.lastUsedAt.getTime() >= DESKTOP_SESSION_TOUCH_INTERVAL_MS) {
    try {
      await db.desktopSession.update({ where: { id: row.id }, data: { lastUsedAt: now } });
    } catch {
      // Touch is advisory - never fail an authenticated request over it.
    }
  }

  return {
    actor: {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      name: user.name,
      email: user.email,
    },
    identity: identityOf(user),
    session: { createdAt: row.createdAt, expiresAt: row.expiresAt, lastUsedAt: row.lastUsedAt },
  };
}

/**
 * Revoke the session for a raw token. Idempotent and quiet: an unknown or
 * already-revoked token is NOT an error (the client still clears its local
 * state). Returns whether a live session was actually revoked by this call.
 */
export async function revokeDesktopSession(
  rawToken: string,
  db: DesktopAuthDb,
  now: Date = new Date(),
): Promise<{ revoked: boolean }> {
  const tokenHash = hashDesktopToken(rawToken);
  try {
    const result = await db.desktopSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revoked: result.count > 0 };
  } catch {
    return { revoked: false };
  }
}

export function desktopSessionResponse(
  resolved: ResolvedDesktopSession,
  now: Date = new Date(),
): DesktopSessionResponseDto {
  return {
    contract: DESKTOP_AUTH_CONTRACT,
    identity: resolved.identity,
    session: {
      createdAt: resolved.session.createdAt.toISOString(),
      expiresAt: resolved.session.expiresAt.toISOString(),
      lastUsedAt: resolved.session.lastUsedAt.toISOString(),
    },
    server: { product: "Arch PLM", time: now.toISOString() },
  };
}
