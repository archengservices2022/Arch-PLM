/**
 * Arch PLM - desktop (Inventor CAD Connect) bearer-session core (P4A,
 * provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system and `node:crypto` (the same builtin `storage-core.ts` uses). Holds
 * the token format, TTL policy, bearer-header parsing, expiry/revocation
 * math, DTO shapes and the domain error. All Prisma wiring lives in
 * `app/lib/desktop-auth-db.ts`; the server-only shim is
 * `app/lib/desktop-auth.ts`.
 *
 * WHY A SEPARATE MECHANISM: the browser dashboard authenticates with
 * NextAuth (CSRF token + credentials-callback cookie). A desktop client
 * cannot reasonably participate in that browser-specific dance, and the
 * reference CLI's `ArchSession` doc comment already anticipates "a future
 * C# CAD Connect client [implementing] the SAME interface with a completely
 * different mechanism (e.g. a bearer token)". This is that mechanism. It is
 * deliberately minimal (Alpha): opaque random token, hashed at rest,
 * server-side expiry + revocation. It is NOT an OAuth/OIDC platform - see
 * `inventor/README.md` "Production auth debt".
 *
 * SECURITY INVARIANTS
 *   - The raw token is 256 bits of CSPRNG output, returned to the client
 *     exactly once. Only `sha256(token)` is ever stored or logged-safe.
 *   - `organizationId` / `userId` are bound into the session row from
 *     verified credentials at creation. Every request this session
 *     authenticates derives the tenant from THAT row - never from anything
 *     the desktop client sends.
 *   - No password is persisted by this module or the client.
 *   - Errors are generic: credential failures never distinguish
 *     "no such user" from "wrong password" from "inactive".
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Every Arch desktop token starts with this. Makes a leaked token instantly
 *  recognizable to a secret scanner and unmistakable in support logs. */
export const DESKTOP_TOKEN_PREFIX = "arch_dt_";

/** 32 random bytes -> 43 base64url chars, after the prefix. */
const DESKTOP_TOKEN_RANDOM_BYTES = 32;

export const DEFAULT_DESKTOP_SESSION_TTL_HOURS = 12;
export const MAX_DESKTOP_SESSION_TTL_HOURS = 24 * 30;

/** Only bump `lastUsedAt` when it is at least this stale, so a chatty client
 *  does not turn every authenticated read into a write. */
export const DESKTOP_SESSION_TOUCH_INTERVAL_MS = 60_000;

export class DesktopAuthError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "DesktopAuthError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/** Resolve the configured session TTL in hours: `DESKTOP_SESSION_TTL_HOURS`
 *  must be a positive integer no greater than the 30-day cap; any other
 *  value falls back to the default rather than disabling expiry. */
export function resolveDesktopSessionTtlHours(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DESKTOP_SESSION_TTL_HOURS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (
      Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed <= MAX_DESKTOP_SESSION_TTL_HOURS
    ) {
      return parsed;
    }
  }
  return DEFAULT_DESKTOP_SESSION_TTL_HOURS;
}

export interface GeneratedDesktopToken {
  /** Return to the client exactly once. Never persist or log. */
  token: string;
  /** SHA-256 (lowercase hex) of `token` - safe to store and to log. */
  tokenHash: string;
}

/** Mint a fresh opaque token + its at-rest hash. */
export function generateDesktopToken(): GeneratedDesktopToken {
  const token =
    DESKTOP_TOKEN_PREFIX + randomBytes(DESKTOP_TOKEN_RANDOM_BYTES).toString("base64url");
  return { token, tokenHash: hashDesktopToken(token) };
}

/** SHA-256 hex of a raw token. The only representation that ever touches the
 *  database or a log line. */
export function hashDesktopToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Extract a bearer token from an `Authorization` header value. Returns null
 * for anything that is not exactly `Bearer <arch-desktop-token>` - a
 * malformed header, a non-bearer scheme, or a token missing the Arch prefix.
 * Never throws, never logs the value.
 */
export function parseBearerToken(
  authorizationHeader: string | null | undefined,
): string | null {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const match = /^Bearer[ \t]+([^\s]+)$/.exec(authorizationHeader.trim());
  if (!match) {
    return null;
  }
  const token = match[1];
  if (!token.startsWith(DESKTOP_TOKEN_PREFIX) || token.length <= DESKTOP_TOKEN_PREFIX.length) {
    return null;
  }
  return token;
}

/** Constant-time compare of two token hashes (both lowercase hex of equal
 *  length). Defensive - the DB lookup is already by unique `tokenHash`, but
 *  any in-code comparison stays timing-safe. */
export function tokenHashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export type DesktopSessionRejectionReason = "expired" | "revoked" | "unknown";

export interface DesktopSessionSnapshot {
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Decide whether a looked-up session row is currently usable. Pure: the
 * caller supplies `now` (defaults to the real clock) so expiry is testable.
 */
export function evaluateDesktopSession(
  session: DesktopSessionSnapshot | null,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: DesktopSessionRejectionReason } {
  if (!session) {
    return { ok: false, reason: "unknown" };
  }
  if (session.revokedAt !== null) {
    return { ok: false, reason: "revoked" };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

// ------------------------------------------------------------
// Transport policy - NO EXCEPTIONS
// ------------------------------------------------------------
//
// Plain HTTP is permitted ONLY for a loopback host: localhost, 127.0.0.1,
// ::1 (the URL parser normalizes the IPv6 form to "[::1]"). Everything else
// - including http://192.168.x.x, http://<machine-name>, http://<remote> -
// requires HTTPS. There is DELIBERATELY no environment variable, config flag
// or UI toggle that can loosen this, in development or production. The C#
// client (`ArchServerUri`) enforces the identical rule before it sends any
// credential or bearer token.
//
// FORWARDED HEADERS ARE NOT TRUSTED. `x-forwarded-proto` / `x-forwarded-host`
// are client-settable and a direct remote HTTP caller could spoof
// `x-forwarded-proto: https` to defeat the check. The guard uses ONLY
// `new URL(request.url)` (protocol + hostname). If a production deployment
// terminates TLS at a proxy, that infrastructure MUST be configured so the
// request URL the application receives already has an https scheme (e.g. via
// the platform's trusted host/proto handling) - the desktop-auth guard will
// not infer it from a header. P4A adds no "trusted proxy" mode.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True only for the exact loopback host names/addresses above. Not the whole
 *  127.0.0.0/8 range - the policy list is deliberately literal. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

/**
 * Enforce the transport policy. `protocol` is `"http:"` / `"https:"`,
 * `hostname` the request host. Throws `DesktopAuthError(400, ...)` - a
 * generic message that never echoes the URL - unless the request is HTTPS,
 * or plain HTTP to a loopback host.
 */
export function assertTransportAllowed(protocol: string, hostname: string): void {
  if (protocol === "https:") {
    return;
  }
  if (protocol === "http:" && isLoopbackHostname(hostname)) {
    return;
  }
  throw new DesktopAuthError(
    400,
    "This endpoint requires HTTPS. Plain HTTP is only permitted for a loopback address (localhost, 127.0.0.1, ::1).",
  );
}

/**
 * Enforce the transport policy for an incoming request, using ONLY
 * `new URL(request.url)` - the protocol and hostname the application itself
 * sees. No request header (`x-forwarded-*` included) is consulted, so a
 * direct remote HTTP client cannot spoof its way past the HTTPS requirement.
 *
 * Every desktop-auth route (login, session, logout) calls this BEFORE it
 * looks at any credential or bearer token.
 */
export function assertRequestTransportAllowed(request: Request): void {
  const url = new URL(request.url);
  assertTransportAllowed(url.protocol, url.hostname);
}

// ------------------------------------------------------------
// Bounded request-body read (desktop login)
// ------------------------------------------------------------

/** Hard cap on the desktop login request body. A credential exchange is a few
 *  hundred bytes; anything larger is rejected with a controlled 413 before
 *  the JSON is parsed. */
export const MAX_DESKTOP_LOGIN_BODY_BYTES = 16 * 1024;

/**
 * Read and JSON-parse a request body, refusing anything over `maxBytes`
 * WITHOUT buffering more than that. Rejects early on an oversized
 * `Content-Length`; otherwise streams and aborts the moment the running
 * total exceeds the cap.
 *
 * @throws DesktopAuthError(413) if the body is (or claims to be) too large.
 * @throws DesktopAuthError(400) if the received bytes are not valid JSON.
 *   Never includes any of the body in the error.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes: number = MAX_DESKTOP_LOGIN_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DesktopAuthError(413, "Request body is too large.");
  }

  const stream = request.body;
  if (!stream) {
    return {};
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new DesktopAuthError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed; nothing to do.
    }
  }

  if (total === 0) {
    return {};
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof DesktopAuthError) {
      throw error;
    }
    throw new DesktopAuthError(400, "Request body is not valid JSON.");
  }
}

// ------------------------------------------------------------
// DTO shapes (wire contract with the C# client)
// ------------------------------------------------------------

export const DESKTOP_AUTH_CONTRACT = "arch-plm.desktop-auth.v1";

export interface DesktopIdentityDto {
  userId: string;
  name: string;
  email: string;
  role: string;
  organization: { id: string; code: string; name: string };
}

export interface DesktopLoginResponseDto {
  contract: typeof DESKTOP_AUTH_CONTRACT;
  tokenType: "Bearer";
  token: string;
  expiresAt: string;
  identity: DesktopIdentityDto;
}

export interface DesktopSessionResponseDto {
  contract: typeof DESKTOP_AUTH_CONTRACT;
  identity: DesktopIdentityDto;
  session: { createdAt: string; expiresAt: string; lastUsedAt: string };
  server: { product: "Arch PLM"; time: string };
}

/** Parse/validate a client-supplied `clientLabel` - free text, display only,
 *  never a security input. Trimmed, capped, control chars stripped, or null. */
export function sanitizeClientLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (0x00-0x1F) and DEL (0x7F); keep the rest, non-ASCII
    // included.
    if (code >= 0x20 && code !== 0x7f) {
      out += ch;
    }
  }
  out = out.trim().slice(0, 120);
  return out.length > 0 ? out : null;
}
