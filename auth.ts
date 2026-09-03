import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { prisma } from "@/app/lib/prisma";

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
        // Find active Arch PLM user
        // -----------------------------------------------------

        const user = await prisma.user.findFirst({
          where: {
            email: {
              equals: email,
              mode: "insensitive",
            },

            active: true,
          },
        });

        if (!user || !user.passwordHash) {
          return null;
        }

        // -----------------------------------------------------
        // Verify password
        // -----------------------------------------------------

        const passwordValid = await bcrypt.compare(
          credentials.password,
          user.passwordHash
        );

        if (!passwordValid) {
          return null;
        }

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
      }

      return session;
    },
  },
});