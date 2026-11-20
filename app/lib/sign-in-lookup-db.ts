/**
 * Arch PLM - exact sign-in lookup (SIGNIN-EXACT, Codex P-1b, follow-up to B05).
 *
 * Both sign-in paths (the browser's credentials provider in auth.ts and the
 * CAD Connect desktop login in desktop-auth-db.ts) used Prisma's
 * `email: { equals, mode: "insensitive" }`. On PostgreSQL Prisma runs that as
 * ILIKE, where "%" and "_" are wildcards. If the input is not escaped, an
 * input such as "%" matches SOME user, while the WP-2A throttle is keyed on
 * the input string - so every new pattern would get a fresh counter for the
 * same account (unlimited password guessing).
 *
 * This lookup never uses a pattern: it compares lower("email") with the
 * already-normalized (trimmed, lower-cased) input, as an ordinary bound
 * parameter. The input therefore names exactly one address, and the throttle
 * key (derived from the same normalized input) names exactly one account.
 *
 * If more than one row matches (two organizations, or two spellings of one
 * address created before B05's G-3 rule), the sign-in is AMBIGUOUS and is
 * refused like an unknown email - never resolved to an arbitrary user.
 *
 * Deliberately no "server-only" and only type imports, so the plain Node test
 * runner loads it with a fake db.
 */
import type { PrismaClient } from "@/app/generated/prisma/client";

export type SignInLookupDb = Pick<PrismaClient, "$queryRaw">;

/**
 * Id of the ONE user whose email equals `normalizedEmail` ignoring case, or
 * null when there is none or more than one. `activeOnly` restricts the match
 * to active users (browser sign-in); the desktop sign-in looks at every user
 * and refuses an inactive one afterwards.
 */
export async function findSignInUserId(
  db: SignInLookupDb,
  normalizedEmail: string,
  options: { activeOnly: boolean },
): Promise<string | null> {
  const rows = options.activeOnly
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "User"
        WHERE lower("email") = ${normalizedEmail}
          AND "active" = true
        LIMIT 2
      `
    : await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "User"
        WHERE lower("email") = ${normalizedEmail}
        LIMIT 2
      `;
  return rows.length === 1 ? rows[0].id : null;
}
