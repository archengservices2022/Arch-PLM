"use server";

/**
 * Arch PLM - B05: Server Actions of the /admin/users page (U1-U5).
 *
 * Each action:
 *  1. takes the actor ONLY from requireActor() (session re-read from the
 *     database: id, organization, role). FormData supplies just the target
 *     user id, the new values and the typed passwords - never an
 *     organization, a role of the actor or an actor id;
 *  2. calls the database layer (user-admin-db.ts), which refuses a non-ADMIN,
 *     re-checks the actor under the admin-row lock and writes the G-1 log line;
 *  3. redirects to /admin/users with an allowlisted notice code - refusals
 *     AND unexpected errors included (Codex B05 L-1), so the admin never gets
 *     an error page. Passwords are never put in a URL, a log or a notice.
 *
 * A reset of one's own password ends one's own web session (G-6); the action
 * then signs out and goes to the login page (Codex B05 I-2).
 */
import { redirect, unstable_rethrow } from "next/navigation";

import { signOut } from "@/auth";
import { requireActor } from "@/app/lib/authz";
import { prisma } from "@/app/lib/prisma";
import {
  changeUserRoleForAdmin,
  createUserForAdmin,
  deactivateUserForAdmin,
  reactivateUserForAdmin,
  resetUserPasswordForAdmin,
  unlockSignInForAdmin,
  type UserAdminActor,
} from "@/app/lib/user-admin-db";
import {
  isCreateUserCorrectableRefusal,
  runUserAdminAction,
  userAdminNotice,
  userAdminNoticeHref,
  userAdminSuccessCode,
} from "@/app/lib/user-admin-notice-core";
import { KEPT_FORM_FIELDS, refusedFormState, type KeptFormState } from "@/app/lib/kept-form-core";

function field(formData: FormData, name: string): unknown {
  return formData.get(name);
}

async function adminActor(): Promise<UserAdminActor> {
  const actor = await requireActor();
  return { userId: actor.userId, organizationId: actor.organizationId, role: actor.role };
}

const RUN_OPTIONS = { rethrowFramework: unstable_rethrow };

/**
 * FE-L3: called through useActionState (<KeepInputForm>). A user-correctable
 * refusal is returned as the same fixed message plus the typed email, name
 * and role - NEVER the passwords (KEPT_FORM_FIELDS.createUser,
 * app/lib/kept-form-core.ts). Success and every other refusal (above all
 * USER_ADMIN_NOT_ADMIN) redirect to the guarded users page as before.
 */
export async function createUserAction(previous: KeptFormState, formData: FormData): Promise<KeptFormState> {
  const actor = await adminActor();
  const { code } = await runUserAdminAction(
    () =>
      createUserForAdmin(
        actor,
        {
          email: field(formData, "email"),
          name: field(formData, "name"),
          role: field(formData, "role"),
          password: field(formData, "password"),
          passwordConfirmation: field(formData, "passwordConfirmation"),
        },
        prisma,
      ),
    () => userAdminSuccessCode("CREATED"),
    RUN_OPTIONS,
  );
  if (isCreateUserCorrectableRefusal(code)) {
    return refusedFormState(previous, userAdminNotice(code).message, formData, KEPT_FORM_FIELDS.createUser);
  }
  redirect(userAdminNoticeHref(code));
}

export async function changeUserRoleAction(formData: FormData) {
  const actor = await adminActor();
  const { code } = await runUserAdminAction(
    () => changeUserRoleForAdmin(actor, field(formData, "userId"), field(formData, "role"), prisma),
    () => userAdminSuccessCode("ROLE_CHANGED"),
    RUN_OPTIONS,
  );
  redirect(userAdminNoticeHref(code));
}

export async function deactivateUserAction(formData: FormData) {
  const actor = await adminActor();
  const { code } = await runUserAdminAction(
    () => deactivateUserForAdmin(actor, field(formData, "userId"), field(formData, "confirm"), prisma),
    () => userAdminSuccessCode("DEACTIVATED"),
    RUN_OPTIONS,
  );
  redirect(userAdminNoticeHref(code));
}

export async function reactivateUserAction(formData: FormData) {
  const actor = await adminActor();
  const { code } = await runUserAdminAction(
    () =>
      reactivateUserForAdmin(
        actor,
        field(formData, "userId"),
        field(formData, "password"),
        field(formData, "passwordConfirmation"),
        prisma,
      ),
    () => userAdminSuccessCode("REACTIVATED"),
    RUN_OPTIONS,
  );
  redirect(userAdminNoticeHref(code));
}

export async function resetUserPasswordAction(formData: FormData) {
  const actor = await adminActor();
  const { code, value } = await runUserAdminAction(
    () =>
      resetUserPasswordForAdmin(
        actor,
        field(formData, "userId"),
        field(formData, "password"),
        field(formData, "passwordConfirmation"),
        prisma,
      ),
    () => userAdminSuccessCode("PASSWORD_RESET"),
    RUN_OPTIONS,
  );
  if (value?.selfReset) {
    // Own password changed: this session is no longer valid (G-6).
    await signOut({ redirectTo: "/login" });
  }
  redirect(userAdminNoticeHref(code));
}

export async function unlockSignInAction(formData: FormData) {
  const actor = await adminActor();
  const { code } = await runUserAdminAction(
    () => unlockSignInForAdmin(actor, field(formData, "userId"), prisma),
    (result) => userAdminSuccessCode(result.wasLocked ? "UNLOCKED" : "NOT_LOCKED"),
    RUN_OPTIONS,
  );
  redirect(userAdminNoticeHref(code));
}
