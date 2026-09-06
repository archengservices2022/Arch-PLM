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
 * A request that presents a bearer token is resolved ONLY as a desktop
 * session (a bad token is 401, never a silent fall-through to cookie auth),
 * and it must first satisfy the P4A transport policy
 * (`assertRequestTransportAllowed` - HTTPS unless a loopback host), which
 * throws `DesktopAuthError(400)`. A request with no bearer token behaves
 * EXACTLY as `getActor()` does today - no transport check, no new failure
 * mode, so the browser/cookie path is unchanged.
 *
 * The tenant (`organizationId` / `userId` / `role`) always comes from the
 * server-verified session, never from anything the client sends.
 *
 * P4B wires this into the CAD Connect read routes (`workspace-plan`,
 * `file-versions/:id/content`) so the Inventor client can call Get Latest
 * with a bearer token; the routes catch `DesktopAuthError` and map it to
 * its status.
 *
 * @throws DesktopAuthError(400) when a bearer request is not over an allowed
 *   transport. Never throws for a cookie request.
 */
export async function resolveApiActor(request: Request): Promise<Actor | null> {
  const bearer = parseBearerToken(request.headers.get("authorization"));
  if (bearer !== null) {
    assertRequestTransportAllowed(request);
    const resolved = await resolveDesktopSession(bearer);
    return resolved?.actor ?? null;
  }
  return getActor();
}
