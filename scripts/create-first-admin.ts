/**
 * Arch PLM - B05 G-5(a): create the FIRST administrator on the pilot database.
 *
 * Run ONLY through scripts/create-first-admin.ps1 (it reads the password at a
 * hidden prompt and passes it on STDIN), once, under the A-ENV go, after a
 * dry run. prisma/seed.ts, setup-admin.ts and the fixture scripts must NOT be
 * run against the pilot database.
 *
 *   node --experimental-strip-types --env-file=<env file> scripts/create-first-admin.ts \
 *     --email <email> --name <name> --org-name <name> --org-code <CODE> \
 *     --expected-database <db> [--dry-run]
 *   STDIN: two lines - the password, then the same password again.
 *
 * SAFETY
 *  - A password is never accepted as an argument or read from the
 *    environment; STDIN must not be a terminal (no echo).
 *  - Before any check: the connected database must be --expected-database;
 *    database, server address and port are printed for the evidence log.
 *  - The rules themselves (refuse when an active ADMIN exists anywhere or the
 *    email exists anywhere, never update a user, one SERIALIZABLE
 *    transaction) are in app/lib/first-admin-db.ts.
 *  - Output: target, outcome and - on success - the G-1 log line (ids only).
 *    The password and its hash are never printed. Unexpected errors print
 *    their name and code only (a database message can quote values).
 *
 * Exit codes: 0 created / dry run passed; 1 refused or failed (nothing
 * written); 2 usage error or target not verified (nothing written).
 */
import { PrismaClient } from "../app/generated/prisma/client.ts";
import {
  FirstAdminUsageError,
  parseFirstAdminArgs,
  parsePasswordStdin,
  type FirstAdminArgs,
} from "../app/lib/first-admin-core.ts";
import { createFirstAdmin, FirstAdminRefusalError } from "../app/lib/first-admin-db.ts";
import { UserAdminRefusalError } from "../app/lib/user-admin-core.ts";
import { describeUnexpectedError } from "../app/lib/user-admin-notice-core.ts";

const MAX_STDIN_BYTES = 4096;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new FirstAdminUsageError(
      "Run this through scripts/create-first-admin.ps1: the password is read from STDIN, not from a terminal.",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new FirstAdminUsageError("STDIN is too long.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fail(exitCode: 1 | 2, message: string): never {
  console.error(message);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  let args: FirstAdminArgs;
  let secrets: { password: string; passwordConfirmation: string };
  try {
    args = parseFirstAdminArgs(process.argv.slice(2));
    secrets = parsePasswordStdin(await readStdin());
  } catch (error) {
    if (error instanceof FirstAdminUsageError) fail(2, error.message);
    fail(2, `Could not read the input: ${describeUnexpectedError(error)}`);
  }

  const prisma = new PrismaClient();
  try {
    const [target] = await prisma.$queryRaw<Array<{ db: string; addr: string | null; port: number | null }>>`
      select current_database() as db,
             host(inet_server_addr()) as addr,
             inet_server_port() as port
    `;
    console.log(`Target database: ${target.db} at ${target.addr ?? "local socket"}:${target.port ?? "-"}`);
    if (target.db !== args.expectedDatabase) {
      fail(2, `Target NOT verified: connected to "${target.db}", expected "${args.expectedDatabase}". Nothing written.`);
    }

    const result = await createFirstAdmin(
      {
        email: args.email,
        name: args.name,
        organizationName: args.organizationName,
        organizationCode: args.organizationCode,
        password: secrets.password,
        passwordConfirmation: secrets.passwordConfirmation,
      },
      prisma,
      { dryRun: args.dryRun },
    );

    if (result.outcome === "dry-run") {
      console.log(
        `DRY RUN PASSED - nothing written. No active administrator exists; ${result.email} is free; ` +
          `organization ${result.organizationCode} ${result.organizationExists ? "exists (same name)" : "would be created"}; ` +
          "the password meets the rules.",
      );
    } else {
      console.log(
        `CREATED first administrator ${result.email} (user ${result.userId}) in organization ` +
          `${result.organizationCode} (${result.organizationCreated ? "created" : "existing"}, ${result.organizationId}).`,
      );
      console.log(JSON.stringify(result.log));
    }
  } catch (error) {
    if (
      error instanceof FirstAdminRefusalError ||
      error instanceof UserAdminRefusalError ||
      error instanceof FirstAdminUsageError
    ) {
      fail(1, `${error.message} Nothing written.`);
    }
    fail(1, `Failed: ${describeUnexpectedError(error)}. Nothing written.`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
