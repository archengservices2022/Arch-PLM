/**
 * Arch PDM - reference CLI client: authenticated session abstraction (P3B-2C).
 *
 * This is the ONLY file in the reference client that knows anything about
 * how Arch PLM's current web session is established (Auth.js/NextAuth's CSRF
 * + credentials-callback cookie dance). Everything else in `cli/` and the
 * whole P3B-2B materializer talk only to the generic `ArchSession` interface
 * - "give me the headers needed to authenticate a request to this origin" -
 * so a future C# CAD Connect client can implement the SAME interface with a
 * completely different mechanism (e.g. a bearer token) without touching the
 * downloader, the plan-fetching logic, or the materializer at all.
 *
 * NextAuth/browser-session internals are deliberately kept OUT of the PDM
 * domain model (`app/lib/**`) - they live only here, in the reference client.
 *
 * SECURITY: this module never logs, prints or persists a password, cookie
 * value or session token. Callers must source credentials from an
 * environment variable or an interactive prompt - never a CLI flag (see
 * `cli/workspace-get.ts`).
 *
 * SECURITY: `assertSessionOriginMatches` binds a session to its origin.
 * `http-content-downloader.ts` and `workspace-plan-client.ts` both call it as
 * the FIRST thing they do, before ever reading `session.authHeaders()` - a
 * session's cookies can never be sent to any origin other than the exact one
 * it was established against.
 */

export interface ArchSession {
  /** The origin (scheme://host[:port]) this session is valid for. */
  readonly origin: string;
  /** Headers to attach to an authenticated request to this session's origin.
   *  Callers must never log the returned value. */
  authHeaders(): Record<string, string>;
}

export class ArchAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchAuthenticationError";
  }
}

/** Thrown when a session's bound origin does not exactly match the origin a
 *  request is about to be sent to. Deliberately generic - it never restates
 *  either origin, so this error is always safe to print. */
export class OriginMismatchError extends Error {
  constructor() {
    super(
      "Refusing to send an authenticated request: the session's origin " +
        "does not match the target origin",
    );
    this.name = "OriginMismatchError";
  }
}

function canonicalOrigin(value: string): string {
  return new URL(value).origin;
}

/**
 * Enforce EXACT origin equality (scheme + host + port, via the URL parser's
 * own normalization) between `session` and `targetOrigin` BEFORE any
 * authenticated request is allowed to proceed.
 *
 * This must be called in the request path itself - inside every function
 * that is about to call `session.authHeaders()` and send a request - not
 * only once at CLI startup, so a session can never be reused against a
 * different origin no matter how it was constructed or passed around. On a
 * mismatch (or if either value fails to parse as a URL) this throws WITHOUT
 * ever calling `session.authHeaders()`, so a mismatched session's cookies
 * are never even retrieved, let alone attached to a request.
 */
export function assertSessionOriginMatches(
  session: ArchSession,
  targetOrigin: string,
): void {
  let sessionOrigin: string;
  let target: string;
  try {
    sessionOrigin = canonicalOrigin(session.origin);
    target = canonicalOrigin(targetOrigin);
  } catch {
    throw new OriginMismatchError();
  }
  if (sessionOrigin !== target) {
    throw new OriginMismatchError();
  }
}

interface FetchLike {
  (url: string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * A cookie-jar-backed `ArchSession` for today's NextAuth (Auth.js) server.
 * Holds only opaque cookie name/value pairs - never a parsed/interpreted
 * session payload - and exposes nothing beyond `authHeaders()`.
 */
class CookieJarArchSession implements ArchSession {
  readonly origin: string;
  readonly #cookies = new Map<string, string>();

  constructor(origin: string) {
    this.origin = origin;
  }

  ingest(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  hasSessionCookie(): boolean {
    for (const name of this.#cookies.keys()) {
      if (name.toLowerCase().endsWith("session-token")) {
        return true;
      }
    }
    return false;
  }

  authHeaders(): Record<string, string> {
    if (this.#cookies.size === 0) {
      return {};
    }
    const cookie = [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return { cookie };
  }
}

/**
 * Authenticate against an Arch PLM server's existing NextAuth credentials
 * flow (CSRF token, then the credentials callback) and return a reusable
 * `ArchSession`. Throws `ArchAuthenticationError` if the credentials are
 * rejected or no session cookie is issued.
 *
 * The password is used exactly once, inside a single POST body, and is
 * never logged, echoed, or retained beyond this call.
 */
export async function loginWithCredentials(
  origin: string,
  email: string,
  password: string,
  fetchImpl: FetchLike = fetch,
): Promise<ArchSession> {
  const session = new CookieJarArchSession(origin);

  const csrfResponse = await fetchImpl(new URL("/api/auth/csrf", origin), {
    method: "GET",
    redirect: "manual",
  });
  session.ingest(csrfResponse);
  if (!csrfResponse.ok) {
    throw new ArchAuthenticationError(
      `Could not obtain a CSRF token (HTTP ${csrfResponse.status})`,
    );
  }
  const csrfBody = (await csrfResponse.json()) as { csrfToken?: unknown };
  if (typeof csrfBody.csrfToken !== "string" || csrfBody.csrfToken.length === 0) {
    throw new ArchAuthenticationError("Server did not return a CSRF token");
  }

  const loginResponse = await fetchImpl(
    new URL("/api/auth/callback/credentials", origin),
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...session.authHeaders(),
      },
      body: new URLSearchParams({
        csrfToken: csrfBody.csrfToken,
        email,
        password,
        json: "true",
      }).toString(),
    },
  );
  session.ingest(loginResponse);

  if (!session.hasSessionCookie()) {
    throw new ArchAuthenticationError(
      "Authentication failed: check the email/password and try again",
    );
  }

  return session;
}
