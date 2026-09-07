import "server-only";

import { getActor, type Actor } from "@/app/lib/authz";
import {
  assertRequestTransportAllowed,
  DesktopAuthError,
  parseBearerToken,
} from "@/app/lib/desktop-auth-core";
import { resolveDesktopSession } from "@/app/lib/desktop-auth";

export { DesktopAuthError };

/**
 * Resolve the authenticated `Actor` for an HTTP API request, accepting
 * EITHER credential form:
 *
 *   - `Authorization: Bearer arch_dt_...` -> a desktop CAD Connect session
 *     (P4A: `DesktopSession` table), or
 *   - the NextAuth session cookie -> the browser dashboard (unchanged).
 *
 * The presence of an `Authorization` header is an EXPLICIT API-auth attempt.
 * Whatever is wrong with it - a non-bearer scheme, a malformed value, an
 * empty token, a non-Arch token, or a token that is expired / revoked /
 * unknown - it NEVER silently falls through to cookie auth: the request is
 * rejected. Only a request with NO `Authorization` header at all uses the
 * cookie/browser path, exactly as `getActor()` does today (no transport
 * check, no new failure mode).
 *
 * An `Authorization`-bearing request must also satisfy the P4A transport
 * policy (`assertRequestTransportAllowed` - HTTPS unless a loopback host),
 * checked BEFORE the token, throwing `DesktopAuthError(400)`. A malformed /
 * non-Arch / empty bearer throws `DesktopAuthError(401)`. A well-formed but
 * invalid / expired / revoked token resolves to `null` (which every caller
 * maps to 401) - still never a cookie fall-through.
 *
 * The tenant (`organizationId` / `userId` / `role`) always comes from the
 * server-verified session, never from anything the client sends.
 *
 * @throws DesktopAuthError(400) disallowed transport for an Authorization
 *   request; DesktopAuthError(401) a malformed / non-Arch Authorization
 *   value. Never throws for a request with no Authorization header.
 */
export async function resolveApiActor(request: Request): Promise<Actor | null> {
  const authorization = request.headers.get("authorization");

  if (authorization === null) {
    // No Authorization header -> browser/cookie path, unchanged.
    return getActor();
  }

  // An Authorization header is present: this is an explicit API-auth attempt.
  // It must be resolved ONLY as a desktop session - never cookie fall-through.
  assertRequestTransportAllowed(request);

  const bearer = parseBearerToken(authorization);
  if (bearer === null) {
    throw new DesktopAuthError(
      401,
      "The Authorization header is not a valid Arch desktop bearer token.",
    );
  }

  const resolved = await resolveDesktopSession(bearer);
  return resolved?.actor ?? null;
}
