import "server-only";

import { prisma } from "@/app/lib/prisma";
import type { Actor } from "@/app/lib/authz";
import {
  desktopResolveHttpResult as desktopResolveHttpResultWith,
  DesktopCadDocError,
  type DesktopCadDocHttpResult,
  type ResolvedCadDocumentDto,
} from "@/app/lib/desktop-cad-documents-db";

/**
 * Server-only entry point for the P4B CAD Connect document-resolve lookup.
 * Thin shim: all logic is in the pure `desktop-cad-documents-core.ts` and the
 * plain (non-`server-only`) `desktop-cad-documents-db.ts`, which the focused
 * tests drive directly with an in-memory fake. This module only supplies the
 * real `prisma` client.
 */
export { DesktopCadDocError };
export type { DesktopCadDocHttpResult, ResolvedCadDocumentDto };

export function desktopResolveHttpResult(
  actor: Actor | null,
  params: URLSearchParams,
): Promise<DesktopCadDocHttpResult> {
  return desktopResolveHttpResultWith(actor, params, prisma);
}
