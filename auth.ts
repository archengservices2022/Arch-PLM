import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { prisma } from "@/app/lib/prisma";
import {
  getSharedLoginThrottle,
  loginThrottleKey,
} from "@/app/lib/login-throttle-core";
import { passwordVersion } from "@/app/lib/user-admin-core";

/** WP-2A (Codex WP2A-L1): compared against when no account / no password
 *  hash exists, so a missing account costs the same bcrypt work. Same value
 *  as the CAD Connect desktop login (`desktop-auth-db.ts`). */
const DUMMY_PASSWORD_HASH =
  "$2a$12$0000000000000000000000000000000000000000000000000000a";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: "jwt",
  },

  pages: {
    signIn: "/login",
  },

  providers: [
    Credentials({
      name: "Arch PLM",

      credentials: {
        email: {
          label: "Email",
          type: "email",
        },

        password: {
          label: "Password",
          type: "password",
        },
      },

      async authorize(credentials) {
        // -----------------------------------------------------
        // Validate credentials
        // -----------------------------------------------------

        if (
          typeof credentials?.email !== "string" ||
          typeof credentials?.password !== "string"
        ) {
          return null;
        }

        const email = credentials.email.trim().toLowerCase();

        // -----------------------------------------------------
        // WP-2A (2A-1): throttle repeated failures per account.
        // Shared with the CAD Connect desktop login. While refused,
        // the password is not checked and the browser sees the
        // normal generic "sign-in failed" (PD-2A-2).
        // -----------------------------------------------------

        const throttle = getSharedLoginThrottle();
        const throttleKey = loginThrottleKey(email);

        // Reserve the attempt BEFORE any await (Codex WP2A-H1): parallel
        // requests cannot get more password checks than the limit allows.
        if (!throttle.beginAttempt(throttleKey).allowed) {
          return null;
        }

        let user;
        let passwordValid = false;
        try {
          // ---------------------------------------------------
          // Find active Arch PLM user
          // ---------------------------------------------------

          user = await prisma.user.findFirst({
            where: {
              email: {
                equals: email,
                mode: "insensitive",
              },

              active: true,
            },
          });

          // ---------------------------------------------------
          // Verify password. A bcrypt comparison is ALWAYS made
          // (against a dummy hash for an unknown / inactive /
          // passwordless account) so response timing does not
          // reveal whether an account exists (Codex WP2A-L1).
          // ---------------------------------------------------

          passwordValid = await bcrypt.compare(
            credentials.password,
            user?.passwordHash ?? DUMMY_PASSWORD_HASH
          );
        } catch (error) {
          // No verdict about the password: release the reservation.
          throttle.cancelAttempt(throttleKey);
          throw error;
        }

        if (!user || !user.passwordHash || !passwordValid) {
          throttle.recordFailure(throttleKey);
          return null;
        }

        throttle.recordSuccess(throttleKey);

        // -----------------------------------------------------
        // Record successful login
        // -----------------------------------------------------

        await prisma.user.update({
          where: {
            id: user.id,
          },

          data: {
            lastLoginAt: new Date(),
          },
        });

        // -----------------------------------------------------
        // Return authenticated Arch PLM identity
        // -----------------------------------------------------

        return {
          id: user.id,
          email: user.email,
          name: user.name,

          // Important for multi-tenant security
          organizationId: user.organizationId,

          // Used later for permissions
          role: user.role,

          // B05 G-6(a): password version. getActor() refuses the session
          // once the user's password hash changes (reset / reactivation).
          pwv: passwordVersion(user.passwordHash),
        };
      },
    }),
  ],

  callbacks: {
    // ---------------------------------------------------------
    // Store Arch PLM identity in JWT
    // ---------------------------------------------------------

    async jwt({ token, user }) {
      if (user) {
        if (!user.id) {
          throw new Error("Authenticated user is missing an ID.");
        }

        token.userId = user.id;
        token.organizationId = user.organizationId;
        token.role = user.role;
        token.pwv = user.pwv ?? null;
      }

      return token;
    },

    // ---------------------------------------------------------
    // Make Arch PLM identity available to server session
    // ---------------------------------------------------------

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId;
        session.user.organizationId = token.organizationId;
        session.user.role = token.role;
        session.user.pwv = token.pwv ?? null;
      }

      return session;
    },
  },
});