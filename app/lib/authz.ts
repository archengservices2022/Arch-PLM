import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma";
import { UserRole } from "@/app/generated/prisma/enums";

// ============================================================
// Arch PLM server-side authorization foundation
//
// ARCHITECTURAL RULE
//
//   Authenticated User
//         -> User.organizationId
//         -> Organization
//         -> Customer / Project / Item
//         -> ItemRevision
//
// The authenticated session is the ONLY source of truth for
// the tenant boundary. organizationId, userId and role are
// never read from FormData, URL params, headers or cookies
// controlled by the browser.
// ============================================================

export interface Actor {
  userId: string;
  organizationId: string;
  role: UserRole;
  name: string;
  email: string;
}

/**
 * Resolve the current authenticated actor.
 *
 * The JWT session is verified against the database on every call so that
 * deactivated users and stale tenant claims cannot act. Memoized per request
 * render pass via React `cache`.
 *
 * Returns `null` when there is no usable authenticated actor.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const session = await auth();
  const sessionUserId = session?.user?.id;

  if (!sessionUserId) {
    return null;
  }

  const user = await prisma.user.findFirst({
    where: {
      id: sessionUserId,
      active: true,
    },
    select: {
      id: true,
      organizationId: true,
      role: true,
      name: true,
      email: true,
    },
  });

  if (!user) {
    return null;
  }

  // Defense in depth: the tenant claim in the signed session must still match
  // the user's organization in the database.
  if (
    session?.user?.organizationId &&
    session.user.organizationId !== user.organizationId
  ) {
    return null;
  }

  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    name: user.name,
    email: user.email,
  };
});

/**
 * Require an authenticated active actor inside a Server Action / Route Handler.
 * Throws when there is no valid session — never redirects.
 */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();

  if (!actor) {
    throw new Error("You must be signed in to perform this action.");
  }

  return actor;
}

/**
 * Require an authenticated active actor inside a Server Component / page.
 * Redirects unauthenticated visitors to the login screen.
 */
export async function requireDashboardActor(): Promise<Actor> {
  const actor = await getActor();

  if (!actor) {
    redirect("/login");
  }

  return actor;
}

// ------------------------------------------------------------
// Role foundation
//
// The full RBAC matrix is intentionally NOT implemented yet.
// These helpers give later work a single place to enforce:
//   ADMIN | ENGINEER | DESIGNER | REVIEWER | APPROVER | VIEWER
// ------------------------------------------------------------

/** Roles allowed to create or change engineering data today. */
export const PLM_WRITE_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.ENGINEER,
  UserRole.DESIGNER,
  UserRole.REVIEWER,
  UserRole.APPROVER,
];

export function hasRole(
  actor: Actor,
  allowed: readonly UserRole[],
): boolean {
  return allowed.includes(actor.role);
}

/** Throws unless the actor holds one of the allowed roles. */
export function assertRole(
  actor: Actor,
  allowed: readonly UserRole[],
): void {
  if (!hasRole(actor, allowed)) {
    throw new Error("You do not have permission to perform this action.");
  }
}

/** Baseline mutation gate: an authenticated active user that is not read-only. */
export function assertCanMutate(actor: Actor): void {
  assertRole(actor, PLM_WRITE_ROLES);
}
