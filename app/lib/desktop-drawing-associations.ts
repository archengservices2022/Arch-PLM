import "server-only";

import { prisma } from "@/app/lib/prisma";
import type { Actor } from "@/app/lib/authz";
import {
  desktopDrawingAssociationsHttpResult as desktopDrawingAssociationsHttpResultWith,
  DesktopDrawingAssociationError,
  type DesktopDrawingAssociationHttpResult,
  type DrawingAssociationsResponseDto,
} from "@/app/lib/desktop-drawing-associations-db";

/**
 * Server-only entry point for the P6D CAD Connect drawing-association
 * lookup. Thin shim: all logic is in the pure
 * `desktop-drawing-associations-core.ts` and the plain (non-`server-only`)
 * `desktop-drawing-associations-db.ts`, which the focused tests drive
 * directly with an in-memory fake. This module only supplies the real
 * `prisma` client.
 */
export { DesktopDrawingAssociationError };
export type { DesktopDrawingAssociationHttpResult, DrawingAssociationsResponseDto };

export function desktopDrawingAssociationsHttpResult(
  actor: Actor | null,
  params: URLSearchParams,
): Promise<DesktopDrawingAssociationHttpResult> {
  return desktopDrawingAssociationsHttpResultWith(actor, params, prisma);
}
