import "server-only";

import { prisma } from "@/app/lib/prisma";
import {
  authenticateDesktopClient as authenticateWith,
  desktopSessionResponse,
  resolveDesktopSession as resolveWith,
  revokeDesktopSession as revokeWith,
  DesktopAuthError,
  DesktopLoginThrottledError,
  type ResolvedDesktopSession,
} from "@/app/lib/desktop-auth-db";
import type {
  DesktopLoginResponseDto,
  DesktopSessionResponseDto,
} from "@/app/lib/desktop-auth-core";

/**
 * Server-only entry point for desktop (Inventor CAD Connect) bearer auth
 * (P4A). Thin shim: all logic is in the pure `desktop-auth-core.ts` and the
 * plain (non-`server-only`) `desktop-auth-db.ts`, which the focused tests
 * drive directly with an in-memory fake. This module only supplies the real
 * `prisma` client.
 */
export { DesktopAuthError, DesktopLoginThrottledError, desktopSessionResponse };
export type { DesktopLoginResponseDto, DesktopSessionResponseDto, ResolvedDesktopSession };

export function authenticateDesktopClient(
  email: unknown,
  password: unknown,
  clientLabel: unknown,
): Promise<DesktopLoginResponseDto> {
  return authenticateWith(email, password, clientLabel, prisma);
}

export function resolveDesktopSession(
  rawToken: string,
): Promise<ResolvedDesktopSession | null> {
  return resolveWith(rawToken, prisma);
}

export function revokeDesktopSession(rawToken: string): Promise<{ revoked: boolean }> {
  return revokeWith(rawToken, prisma);
}
