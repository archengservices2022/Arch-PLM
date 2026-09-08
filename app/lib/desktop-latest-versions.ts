import "server-only";

import { prisma } from "@/app/lib/prisma";
import type { Actor } from "@/app/lib/authz";
import {
  desktopLatestVersionsHttpResult as desktopLatestVersionsHttpResultWith,
  DesktopLatestVersionError,
  type DesktopLatestVersionHttpResult,
  type LatestVersionsResponseDto,
} from "@/app/lib/desktop-latest-versions-db";

/**
 * Server-only entry point for the P5B-B authoritative latest-version lookup.
 * Thin shim: all logic is in the pure `desktop-latest-versions-core.ts` and
 * the plain (non-`server-only`) `desktop-latest-versions-db.ts`, which the
 * focused tests drive directly with an in-memory fake. This module only
 * supplies the real `prisma` client.
 */
export { DesktopLatestVersionError };
export type { DesktopLatestVersionHttpResult, LatestVersionsResponseDto };

export function desktopLatestVersionsHttpResult(
  actor: Actor | null,
  params: URLSearchParams,
): Promise<DesktopLatestVersionHttpResult> {
  return desktopLatestVersionsHttpResultWith(actor, params, prisma);
}
