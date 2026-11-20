/**
 * Arch PLM - B05 G-5(a): first administrator on the pilot database - pure
 * input handling for scripts/create-first-admin.ts.
 *
 * The operator runs the script ONCE, through scripts/create-first-admin.ps1,
 * which reads the password twice at a hidden prompt and passes it on STDIN -
 * never in argv or an environment variable. Email, name and the organization
 * (Codex B05 I-3) are ordinary arguments; they are not secret.
 *
 * Pure: no I/O, no Prisma.
 */

export const ORG_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export interface FirstAdminArgs {
  email: string;
  name: string;
  organizationName: string;
  organizationCode: string;
  expectedDatabase: string;
  dryRun: boolean;
}

export class FirstAdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirstAdminUsageError";
  }
}

const VALUE_FLAGS = {
  "--email": "email",
  "--name": "name",
  "--org-name": "organizationName",
  "--org-code": "organizationCode",
  "--expected-database": "expectedDatabase",
} as const;

type ValueKey = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

export const FIRST_ADMIN_USAGE =
  "Usage: create-first-admin.ts --email <email> --name <name> --org-name <name> --org-code <CODE> " +
  "--expected-database <db> [--dry-run]   (the password is read from STDIN: two lines, entered twice)";

/**
 * Parse the arguments. Every value flag exactly once; no unknown flags; no
 * password flag exists, and anything that looks like one is refused.
 */
export function parseFirstAdminArgs(argv: readonly string[]): FirstAdminArgs {
  const values: Partial<Record<ValueKey, string>> = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      if (dryRun) throw new FirstAdminUsageError(`--dry-run given twice. ${FIRST_ADMIN_USAGE}`);
      dryRun = true;
      continue;
    }
    if (/pass(word)?|secret|pwd/i.test(flag)) {
      throw new FirstAdminUsageError("A password is never accepted as an argument; it is read from STDIN.");
    }
    if (!Object.prototype.hasOwnProperty.call(VALUE_FLAGS, flag)) {
      throw new FirstAdminUsageError(`Unknown argument. ${FIRST_ADMIN_USAGE}`);
    }
    const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new FirstAdminUsageError(`${flag} needs a value. ${FIRST_ADMIN_USAGE}`);
    }
    if (values[key] !== undefined) throw new FirstAdminUsageError(`${flag} given twice. ${FIRST_ADMIN_USAGE}`);
    values[key] = value;
    i += 1;
  }
  for (const key of Object.values(VALUE_FLAGS)) {
    if (values[key] === undefined) throw new FirstAdminUsageError(`Missing argument. ${FIRST_ADMIN_USAGE}`);
  }
  return {
    email: values.email!,
    name: values.name!,
    organizationName: values.organizationName!,
    organizationCode: values.organizationCode!,
    expectedDatabase: values.expectedDatabase!,
    dryRun,
  };
}

/**
 * STDIN must be exactly two lines: the password and its repetition (the
 * wrapper writes them). Line ends (LF or CRLF) are removed; nothing else is
 * trimmed. The values are never put in an error message.
 */
export function parsePasswordStdin(text: string): { password: string; passwordConfirmation: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  if (lines.length !== 2) {
    throw new FirstAdminUsageError("STDIN must contain exactly two lines: the password, then the same password again.");
  }
  return { password: lines[0], passwordConfirmation: lines[1] };
}

/** Organization code: trimmed, upper-cased, 2-32 of A-Z 0-9 _ - (starting with a letter or digit). */
export function normalizeOrganizationCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!ORG_CODE_PATTERN.test(code)) {
    throw new FirstAdminUsageError("The organization code must be 2-32 characters: A-Z, 0-9, _ or -.");
  }
  return code;
}
