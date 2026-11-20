import Link from "next/link";

import { ActionNotice } from "@/app/components/action-notice";
import { UserRole } from "@/app/generated/prisma/enums";
import { requireDashboardActor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import { MIN_PASSWORD_CHARS } from "@/app/lib/user-admin-core";
import { parseUserAdminNotice, userAdminNotice } from "@/app/lib/user-admin-notice-core";
import { loadAdminUsersView, type AdminUserRow } from "@/app/lib/user-admin-view-db";
import { DEACTIVATE_CONFIRMATION_VALUE } from "@/app/lib/user-admin-db";

import {
  changeUserRoleAction,
  createUserAction,
  deactivateUserAction,
  reactivateUserAction,
  resetUserPasswordAction,
} from "./actions";

// ============================================================
// B05: user administration (/admin/users)
//
// AC1: only an ADMIN (role re-read from the database by getActor) sees the
// user list and the forms. Anyone else gets a notice and NO user data - the
// list is not even queried (loadAdminUsersView). The actions re-check
// everything on the server; hiding a button here is convenience only.
// Passwords are typed into password fields and never shown or sent back.
// ============================================================

const ROLES = Object.values(UserRole);

const inputClass =
  "h-9 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none";
const buttonClass =
  "h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 transition hover:bg-slate-100";
const primaryButtonClass =
  "h-9 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800";

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never";
}

function PasswordPair({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <label className="sr-only" htmlFor={`${idPrefix}-password`}>
        New password
      </label>
      <input
        id={`${idPrefix}-password`}
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_CHARS}
        placeholder={`New password (${MIN_PASSWORD_CHARS}+)`}
        className={inputClass}
      />
      <label className="sr-only" htmlFor={`${idPrefix}-confirm`}>
        Repeat new password
      </label>
      <input
        id={`${idPrefix}-confirm`}
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_CHARS}
        placeholder="Repeat password"
        className={inputClass}
      />
    </>
  );
}

function UserRowView({ user }: { user: AdminUserRow }) {
  return (
    <tr className="border-t border-slate-200 align-top">
      <td className="px-3 py-3">
        <div className="font-semibold text-slate-900">
          {user.name}
          {user.isSelf ? <span className="ml-2 text-xs font-normal text-slate-500">(you)</span> : null}
        </div>
        <div className="text-xs text-slate-600">{user.email}</div>
      </td>
      <td className="px-3 py-3 text-sm">{user.active ? "Active" : "Deactivated"}</td>
      <td className="px-3 py-3 text-xs text-slate-600">{formatDate(user.lastLoginAt)}</td>
      <td className="px-3 py-3">
        {user.isSelf ? (
          <span className="text-sm">{user.role}</span>
        ) : (
          <form action={changeUserRoleAction} className="flex gap-2">
            <input type="hidden" name="userId" value={user.id} />
            <label className="sr-only" htmlFor={`role-${user.id}`}>
              Role
            </label>
            <select id={`role-${user.id}`} name="role" defaultValue={user.role} className={inputClass}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button className={buttonClass}>Change role</button>
          </form>
        )}
      </td>
      <td className="space-y-2 px-3 py-3">
        {user.active ? (
          <>
            {user.isSelf ? null : (
              <form action={deactivateUserAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="userId" value={user.id} />
                {/* C2-L2: confirmed on the server too (DEACTIVATE_CONFIRMATION_VALUE). */}
                <label className="flex items-center gap-1 text-xs text-slate-700">
                  <input type="checkbox" name="confirm" value={DEACTIVATE_CONFIRMATION_VALUE} required />
                  I confirm
                </label>
                <button className={buttonClass}>Deactivate</button>
              </form>
            )}
            <form action={resetUserPasswordAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="userId" value={user.id} />
              <PasswordPair idPrefix={`reset-${user.id}`} />
              <button className={buttonClass}>Reset password</button>
            </form>
          </>
        ) : (
          <form action={reactivateUserAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="userId" value={user.id} />
            <PasswordPair idPrefix={`reactivate-${user.id}`} />
            <button className={buttonClass}>Reactivate with new password</button>
          </form>
        )}
      </td>
    </tr>
  );
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const actor = await requireDashboardActor();
  const view = await loadAdminUsersView(actor, prisma);

  // C2-L3: notices only for an admin - a non-admin following a crafted
  // ?notice=ok.CREATED link must not see "Done: User created."
  const noticeCode = view.allowed ? parseUserAdminNotice((await searchParams).notice) : null;
  const notice = noticeCode ? userAdminNotice(noticeCode) : null;

  return (
    <main className="min-h-screen bg-stone-100 text-slate-950">
      <section className="mx-auto max-w-7xl px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
            Arch PLM - Users
          </p>
          <Link href="/" className="text-sm font-semibold text-teal-800 hover:underline">
            Back to dashboard
          </Link>
        </div>

        {notice ? <ActionNotice message={notice.message} kind={notice.kind} /> : null}

        {!view.allowed ? (
          <div role="alert" className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            Only an administrator can manage users.
          </div>
        ) : (
          <>
            <h1 className="mt-4 text-3xl font-semibold">Users</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-700">
              Users of your organization. Deactivating a user or resetting a password ends that user&apos;s
              web and CAD Connect sessions. Give new passwords to the user in person.
            </p>

            <form
              action={createUserAction}
              className="mt-6 grid gap-2 rounded-md border border-slate-300 bg-white p-4 md:grid-cols-[1fr_1fr_auto]"
            >
              <h2 className="text-sm font-semibold md:col-span-3">Create user</h2>
              <input name="email" type="email" required maxLength={254} placeholder="Email" autoComplete="off" className={inputClass} />
              <input name="name" required maxLength={100} placeholder="Name" autoComplete="off" className={inputClass} />
              <select name="role" defaultValue={UserRole.VIEWER} className={inputClass} aria-label="Role">
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2 md:col-span-3">
                <PasswordPair idPrefix="create" />
                <button className={primaryButtonClass}>Create user</button>
              </div>
            </form>

            <div className="mt-6 overflow-x-auto rounded-md border border-slate-300 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Last sign-in</th>
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {view.users.map((user) => (
                    <UserRowView key={user.id} user={user} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
