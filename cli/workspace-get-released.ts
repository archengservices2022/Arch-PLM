/**
 * Arch PDM - reference CLI for retrieving a RELEASED revision's frozen
 * engineering baseline (P3D-2).
 *
 * Development/testing reference client only - proves the real, end-to-end
 * released-retrieval protocol (authenticated Arch user -> released-workspace
 * endpoint -> pinned FileVersion content endpoints -> streamed verified
 * downloads -> managed local workspace) against a running Arch server. This
 * is a SEPARATE, explicit mode from `workspace-get.ts` (working/"latest"
 * retrieval) rather than an overload of it - see this file's own flag
 * (`--revision`, not `--document`) and the fact that it hits a completely
 * different endpoint and contract.
 *
 * Usage:
 *   npm run workspace:get-released -- --server http://localhost:3000 \
 *     --revision <itemRevisionId> --workspace <absolute-path>
 *
 * Credentials: identical rules to `workspace-get.ts` (see that file's doc
 * comment) - ARCH_EMAIL / ARCH_PASSWORD via environment or masked
 * interactive prompt only, every password-bearing CLI argument form
 * rejected before it is ever inspected further, no password/email ever
 * accepted as a flag.
 */
import { pathToFileURL } from "node:url";

import { loginWithCredentials } from "./arch-session.ts";
import { assertHttpOrigin } from "./orchestrate-workspace-get.ts";
import { runReleasedWorkspaceGet } from "./orchestrate-workspace-get-released.ts";
import { isPasswordArgument } from "./workspace-get.ts";
import type { MaterializationReport } from "../app/lib/workspace-materialize-core.ts";

interface CliArgs {
  server: string;
  revision: string;
  workspace: string;
}

const PASSWORD_ARGUMENT_ERROR =
  "Password arguments are not allowed. Use ARCH_PASSWORD or interactive input.";

export function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    // Checked FIRST, before anything else touches `arg` - see
    // `workspace-get.ts`'s `isPasswordArgument` for the exact forms rejected.
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
      case "--revision":
        args.revision = next();
        break;
      case "--workspace":
        args.workspace = next();
        break;
      default:
        // Deliberately does not echo `arg` - see workspace-get.ts.
        throw new Error("Unknown argument");
    }
  }
  if (!args.server || !args.revision || !args.workspace) {
    throw new Error(
      "Usage: workspace:get-released -- --server <url> --revision <itemRevisionId> --workspace <absolute-path>",
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

  const report = await runReleasedWorkspaceGet({
    serverUrl: args.server,
    itemRevisionId: args.revision,
    workspaceRoot: args.workspace,
    session,
  });

  printReport(report);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(
      `workspace:get-released failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
