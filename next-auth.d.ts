import type { DefaultSession } from "next-auth";

import type { UserRole } from "@/app/generated/prisma/enums";

// ============================================================
// Arch PLM custom session typing
//
// The authenticated session is the source of truth for
// multi-tenant boundaries. `organizationId` and `role` are
// derived on the server during sign-in and must never be
// accepted from the browser.
// ============================================================

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      role: UserRole;
      /** B05 G-6(a): password version at sign-in (see user-admin-core.ts). */
      pwv: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    organizationId: string;
    role: UserRole;
    pwv?: string | null;
  }
}

// `next-auth/jwt` only re-exports from `@auth/core/jwt`, so the `JWT`
// interface must be augmented at its source module to merge correctly.
declare module "@auth/core/jwt" {
  interface JWT {
    userId: string;
    organizationId: string;
    role: UserRole;
    pwv?: string | null;
  }
}
