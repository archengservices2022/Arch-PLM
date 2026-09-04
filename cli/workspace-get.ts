/**
 * Arch PDM - reference CLI for the authenticated "Get" protocol (P3B-2C).
 *
 * Development/testing reference client only - proves the real, end-to-end
 * protocol (authenticated Arch user -> workspace-plan endpoint -> pinned
 * FileVersion content endpoints -> streamed verified downloads -> managed
 * local workspace) against a running Arch server. This is NOT the future C#
 * CAD Connect client and does not integrate Autodesk Inventor; it exists so
 * the protocol can be exercised and tested without one.
 *
 * Usage:
 *   npm run workspace:get -- --server http://localhost:3000 \
 *     --document <cadDocumentId> --workspace <absolute-path>
 *
 * Credentials:
 *   Set ARCH_EMAIL and ARCH_PASSWORD in the environment - NEVER as CLI
 *   flags (a --password flag would leak into shell history and process
 *   listings). Every password-bearing argument FORM is refused before it is
 *   ever inspected further: `--password`, `--password=value`, `-p`,
 *   `-pvalue`, `-p=value`. The rejection message is fixed and generic and
 *   never echoes the argument or any value. When running interactively in
 *   a real terminal with either missing, this prompts for them (password
 *   input is masked). In a non-interactive context, missing credentials are
 *   a hard, immediate error rather than a hang.
 *
 * This file is a thin entry point: argument parsing, credential collection,
 * and printing. Most protocol logic lives in `orchestrate-workspace-get.ts` /
 * `workspace-plan-client.ts` / `http-content-downloader.ts` /
 * `arch-session.ts`. `parseArgs` / `isPasswordArgument` are exported so the
 * password-argument-rejection tests can call them directly; importing this
 * module does NOT run the CLI (see the `isMainModule` guard at the bottom) -
 * `main()` only executes when this file is the actual process entry point.
 */
import { pathToFileURL } from "node:url";

import { loginWithCredentials } from "./arch-session.ts";
import {
  assertHttpOrigin,
  runWorkspaceGet,
} from "./orchestrate-workspace-get.ts";
import type { MaterializationReport } from "../app/lib/workspace-materialize-core.ts";

interface CliArgs {
  server: string;
  document: string;
  workspace: string;
}

/**
 * The exact, generic message required whenever ANY password-bearing
 * argument form is rejected. It never restates the argument or a value, so
 * it is always safe to print to stdout/stderr - there is nothing in it that
 * could ever be (or embed) a secret.
 */
const PASSWORD_ARGUMENT_ERROR =
  "Password arguments are not allowed. Use ARCH_PASSWORD or interactive input.";

/**
 * True for every password-bearing argument FORM, not just the bare flag:
 * `--password`, `--password=<anything>`, `-p`, `-p<anything>` (covers both
 * `-pvalue` and `-p=value`). Matched on shape alone - the possible secret
 * value that might follow or be embedded in `arg` is never inspected,
 * extracted, or referenced anywhere.
 */
export function isPasswordArgument(arg: string): boolean {
  return (
    arg === "--password" ||
    arg.startsWith("--password=") ||
    arg === "-p" ||
    (arg.startsWith("-p") && arg.length > 2)
  );
}

export function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    // Checked FIRST, before anything else touches `arg`: reject every
    // password-flag form immediately, with a fixed generic message that
    // never echoes the argument or any value.
    if (isPasswordArgument(arg)) {
      throw new Error(PASSWORD_ARGUMENT_ERROR);
    }
    if (arg === "--email" || arg === "-e") {
      throw new Error(
        "Email must not be passed on the command line. Set ARCH_EMAIL in the environment instead.",
      );
    }

    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      return value;
    };
    switch (arg) {
      case "--server":
        args.server = next();
        break;
      case "--document":
        args.document = next();
        break;
      case "--workspace":
        args.workspace = next();
        break;
      default:
        // Deliberately does not echo `arg`: an unrecognized flag or a stray
        // value left over from one (e.g. a mistyped password form this
        // parser doesn't otherwise recognize) must never appear in an error
        // message.
        throw new Error("Unknown argument");
    }
  }
  if (!args.server || !args.document || !args.workspace) {
    throw new Error(
      "Usage: workspace:get -- --server <url> --document <cadDocumentId> --workspace <absolute-path>",
    );
  }
  return args as CliArgs;
}

async function promptVisible(question: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** A minimal masked-input prompt for interactive dev use. Never echoes or
 *  logs the characters typed. */
async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : undefined;
    stdin.resume();
    stdin.setEncoding("utf8");
    if (stdin.isTTY) stdin.setRawMode(true);

    let input = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      const char = chunk.toString();
      if (char === "\n" || char === "\r" || char === "\u0004") {
        cleanup();
        process.stdout.write("\n");
        resolve(input);
        return;
      }
      if (char === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Cancelled"));
        return;
      }
      if (char === "\u007f" || char === "\b") {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on("data", onData);
  });
}

async function resolveCredentials(): Promise<{ email: string; password: string }> {
  const envEmail = process.env.ARCH_EMAIL;
  const envPassword = process.env.ARCH_PASSWORD;
  if (envEmail && envPassword) {
    return { email: envEmail, password: envPassword };
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "ARCH_EMAIL and ARCH_PASSWORD must both be set in the environment " +
        "when not running interactively.",
    );
  }
  const email = envEmail ?? (await promptVisible("Arch email: "));
  const password = envPassword ?? (await promptHidden("Arch password: "));
  if (!email || !password) {
    throw new Error("Email and password are required");
  }
  return { email, password };
}

function printReport(report: MaterializationReport): void {
  console.log(`Workspace: ${report.workspaceRoot}`);
  console.log(
    `Entries: ${report.requestedEntries} - downloaded ${report.summary.downloaded}, ` +
      `already-current ${report.summary.alreadyCurrent}, blocked ${report.summary.blocked}, ` +
      `failed ${report.summary.failed}`,
  );
  for (const r of report.results) {
    const detail = r.relativePath ? ` (${r.relativePath})` : "";
    const reason = r.reason ? ` - ${r.reason}` : "";
    console.log(`  [${r.status}] ${r.cadDocumentId}${detail}${reason}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = assertHttpOrigin(args.server);
  const { email, password } = await resolveCredentials();

  const session = await loginWithCredentials(origin, email, password);

  const report = await runWorkspaceGet({
    serverUrl: args.server,
    cadDocumentId: args.document,
    workspaceRoot: args.workspace,
    session,
  });

  printReport(report);
}

// Only run the CLI when this file is the actual process entry point -
// importing it (e.g. from a test, for `parseArgs`) must never execute it.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(
      `workspace:get failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
