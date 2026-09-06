import "server-only";

import { getActor, type Actor } from "@/app/lib/authz";
import { parseBearerToken } from "@/app/lib/desktop-auth-core";
import { resolveDesktopSession } from "@/app/lib/desktop-auth";

/**
 * Resolve the authenticated `Actor` for an HTTP API request, accepting
 * EITHER credential form:
 *
 *   - `Authorization: Bearer arch_dt_...` -> a desktop CAD Connect session
 *     (P4A: `DesktopSession` table), or
 *   - the NextAuth session cookie -> the browser dashboard (unchanged).
 *
 * A request that presents a bearer token is resolved ONLY as a desktop
 * session (a bad token is 401, never a silent fall-through to cookie auth).
 * A request with no bearer token behaves EXACTLY as `getActor()` does today.
 *
 * The tenant (`organizationId` / `userId` / `role`) always comes from the
 * server-verified session, never from anything the client sends.
 *
 * P4A wires this into the new `/api/desktop/*` routes only. The existing PLM
 * route handlers still use `getActor()` directly; switching them to this
 * helper (so the Inventor client can call Get Latest / Checkout / ... with a
 * bearer token) is a mechanical follow-up in P4B, when those operations are
 * actually implemented on the client.
 */
export async function resolveApiActor(request: Request): Promise<Actor | null> {
  const bearer = parseBearerToken(request.headers.get("authorization"));
  if (bearer !== null) {
    const resolved = await resolveDesktopSession(bearer);
    return resolved?.actor ?? null;
  }
  return getActor();
}
