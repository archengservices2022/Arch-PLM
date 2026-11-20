/**
 * Arch PLM - B05: data for the /admin/users page.
 *
 * AC1: only an ADMIN sees the list. The role is the actor's role as re-read
 * from the database by getActor(); for anyone else NOTHING is queried and the
 * page shows only a notice. The list is the actor's OWN organization only;
 * the selected fields contain no password hash.
 *
 * No "server-only" and only type imports, so the plain Node test runner loads
 * it with a fake db.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";
import { UserRole } from "../generated/prisma/enums.ts";
import { getSharedLoginThrottle, loginThrottleKey } from "./login-throttle-core.ts";

export type UserAdminViewDb = Pick<PrismaClient, "user">;

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  lastLoginAt: Date | null;
  isSelf: boolean;
  /** B05 U5: sign-in currently refused by the WP-2A throttle (this process). */
  signInLocked: boolean;
}

export type AdminUsersView = { allowed: false } | { allowed: true; users: AdminUserRow[] };

/** Default: ask this process's shared login throttle, with sign-in's key. */
function sharedThrottleLocked(email: string): boolean {
  return !getSharedLoginThrottle().check(loginThrottleKey(email)).allowed;
}

export async function loadAdminUsersView(
  actor: { userId: string; organizationId: string; role: UserRole },
  db: UserAdminViewDb,
  isSignInLocked: (email: string) => boolean = sharedThrottleLocked,
): Promise<AdminUsersView> {
  if (actor.role !== UserRole.ADMIN) return { allowed: false };
  const rows = await db.user.findMany({
    where: { organizationId: actor.organizationId },
    select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true },
    orderBy: [{ active: "desc" }, { email: "asc" }],
  });
  return {
    allowed: true,
    users: rows.map((row) => ({
      ...row,
      isSelf: row.id === actor.userId,
      signInLocked: isSignInLocked(row.email),
    })),
  };
}
