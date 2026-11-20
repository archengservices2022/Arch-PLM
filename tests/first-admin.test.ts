/**
 * B05 commit 4 (G-5(a)): first administrator - argument/STDIN handling,
 * the database step with an in-memory fake, and source checks on the script
 * and its PowerShell wrapper (including the pinned hashes).
 *   node --experimental-strip-types --test tests/first-admin.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  FirstAdminUsageError,
  normalizeOrganizationCode,
  parseFirstAdminArgs,
  parsePasswordStdin,
} from "../app/lib/first-admin-core.ts";
import {
  createFirstAdmin,
  FIRST_ADMIN_SCRIPT_ACTOR,
  FirstAdminRefusalError,
  type FirstAdminDb,
  type FirstAdminInput,
} from "../app/lib/first-admin-db.ts";
import { UserAdminRefusalError } from "../app/lib/user-admin-core.ts";
import { ActionRefusalError } from "../app/lib/action-notice-core.ts";

const PW = "a-sixteen-char-pw!";
const ARGS = [
  "--email", "Admin@Arch.test",
  "--name", "Pilot Admin",
  "--org-name", "Arch Engineering Services",
  "--org-code", "arch",
  "--expected-database", "arch_plm_pilot",
];

// ------------------------------------------------------------
// Arguments and STDIN
// ------------------------------------------------------------

test("args: all value flags once, optional --dry-run", () => {
  assert.deepEqual(parseFirstAdminArgs(ARGS), {
    email: "Admin@Arch.test",
    name: "Pilot Admin",
    organizationName: "Arch Engineering Services",
    organizationCode: "arch",
    expectedDatabase: "arch_plm_pilot",
    dryRun: false,
  });
  assert.equal(parseFirstAdminArgs([...ARGS, "--dry-run"]).dryRun, true);
});

test("args: missing, repeated, unknown or value-less flags are refused; a password argument is never accepted", () => {
  const bad: string[][] = [
    ARGS.slice(0, -2),
    [...ARGS, "--email", "x@y.io"],
    [...ARGS, "--dry-run", "--dry-run"],
    [...ARGS, "--force"],
    ["--email", "--name", ...ARGS.slice(2)],
    [...ARGS, "--password", PW],
    [...ARGS, "--pwd=x"],
    [...ARGS, "--admin-secret", "x"],
  ];
  for (const argv of bad) {
    assert.throws(() => parseFirstAdminArgs(argv), FirstAdminUsageError, argv.join(" "));
  }
  try {
    parseFirstAdminArgs([...ARGS, "--password", PW]);
  } catch (error) {
    assert.ok(!(error as Error).message.includes(PW));
  }
});

test("stdin: exactly two lines (LF or CRLF, optional final newline); nothing trimmed; values never in errors", () => {
  assert.deepEqual(parsePasswordStdin(`${PW}\n${PW}\n`), { password: PW, passwordConfirmation: PW });
  assert.deepEqual(parsePasswordStdin(`${PW}\r\n${PW}`), { password: PW, passwordConfirmation: PW });
  assert.deepEqual(parsePasswordStdin(` ${PW}\n${PW}`), { password: ` ${PW}`, passwordConfirmation: PW });
  for (const text of ["", PW, `${PW}\n`, `${PW}\n${PW}\n${PW}`, `${PW}\n${PW}\n\n`]) {
    assert.throws(() => parsePasswordStdin(text), (error: unknown) => {
      return error instanceof FirstAdminUsageError && !error.message.includes(PW);
    });
  }
});

test("organization code: trimmed, upper-cased, 2-32 of A-Z 0-9 _ -", () => {
  assert.equal(normalizeOrganizationCode(" arch-1 "), "ARCH-1");
  for (const bad of ["A", "-ARCH", "AR CH", "ÄRCH", "x".repeat(33), ""]) {
    assert.throws(() => normalizeOrganizationCode(bad), FirstAdminUsageError, bad);
  }
});

// ------------------------------------------------------------
// The database step (fake)
// ------------------------------------------------------------

interface FakeUser { id: string; organizationId: string; email: string; role: string; active: boolean; name: string; passwordHash: string | null }
interface FakeOrg { id: string; code: string; name: string }

class SerializationConflict extends Error {
  readonly code = "P2034";
}

class FakeDb {
  users: FakeUser[] = [];
  orgs: FakeOrg[] = [];
  readonly ops: string[] = [];
  conflictsToThrow = 0;
  interleave: (() => Promise<unknown>) | null = null;
  #n = 1;

  get db(): FirstAdminDb {
    return {
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>, opts?: { isolationLevel?: unknown }) => {
        assert.equal(opts?.isolationLevel, "Serializable");
        const hook = this.interleave;
        this.interleave = null;
        if (hook) await hook();
        let conflict = hook !== null;
        if (!conflict && this.conflictsToThrow > 0) {
          this.conflictsToThrow -= 1;
          conflict = true;
        }
        const users = this.users.map((u) => ({ ...u }));
        const orgs = this.orgs.map((o) => ({ ...o }));
        this.ops.push("begin");
        try {
          const result = await fn(this.#tx(conflict));
          this.ops.push("commit");
          return result;
        } catch (error) {
          this.users = users;
          this.orgs = orgs;
          this.ops.push("rollback");
          throw error;
        }
      }) as unknown as FirstAdminDb["$transaction"],
    };
  }

  #tx(conflict: boolean) {
    return {
      user: {
        findFirst: async (args: { where: { role: string; active: boolean } }) => {
          this.ops.push("find-admin");
          if (conflict) throw new SerializationConflict("conflict");
          const u = this.users.find((x) => x.role === args.where.role && x.active === args.where.active);
          return u ? { id: u.id } : null;
        },
        create: async (args: { data: Omit<FakeUser, "id"> }) => {
          this.ops.push("create-user");
          const user = { id: `u${this.#n++}`, ...args.data };
          this.users.push(user);
          return { id: user.id };
        },
      },
      organization: {
        findUnique: async (args: { where: { code: string } }) => {
          this.ops.push("find-org");
          const o = this.orgs.find((x) => x.code === args.where.code);
          return o ? { id: o.id, name: o.name } : null;
        },
        create: async (args: { data: { name: string; code: string } }) => {
          this.ops.push("create-org");
          const org = { id: `o${this.#n++}`, ...args.data };
          this.orgs.push(org);
          return { id: org.id };
        },
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        this.ops.push("email-check");
        assert.match(strings.join("?"), /lower\("email"\) = \?/);
        const email = values[0] as string;
        const hit = this.users.find((u) => u.email.toLowerCase() === email);
        return hit ? [{ id: hit.id }] : [];
      },
    };
  }
}

const NOW = new Date("2026-11-20T15:00:00.000Z");

function input(overrides: Partial<FirstAdminInput> = {}): FirstAdminInput {
  return {
    email: " Admin@Arch.test ",
    name: "Pilot Admin",
    organizationName: "Arch Engineering Services",
    organizationCode: "arch",
    password: PW,
    passwordConfirmation: PW,
    ...overrides,
  };
}

function options(extra: Record<string, unknown> = {}) {
  const hashed: string[] = [];
  return {
    hashed,
    opts: {
      now: () => NOW,
      hashPassword: async (pw: string) => {
        hashed.push(pw);
        return "bcrypt-hash";
      },
      ...extra,
    },
  };
}

test("creates the organization and the first ADMIN on an empty database; G-1 line with ids only", async () => {
  const fake = new FakeDb();
  const { hashed, opts } = options();
  const result = await createFirstAdmin(input(), fake.db, opts);
  assert.equal(result.outcome, "created");
  assert.ok(result.outcome === "created");
  assert.deepEqual(fake.orgs, [{ id: result.organizationId, code: "ARCH", name: "Arch Engineering Services" }]);
  assert.deepEqual(fake.users, [
    { id: result.userId, organizationId: result.organizationId, email: "admin@arch.test", name: "Pilot Admin", role: "ADMIN", passwordHash: "bcrypt-hash", active: true },
  ]);
  assert.equal(result.organizationCreated, true);
  assert.deepEqual(hashed, [PW]);
  assert.deepEqual(fake.ops, ["begin", "find-admin", "email-check", "find-org", "create-org", "create-user", "commit"]);
  assert.deepEqual(
    [result.log.action, result.log.outcome, result.log.actorUserId, result.log.targetUserId, result.log.newRole, result.log.at],
    ["create_first_admin", "committed", FIRST_ADMIN_SCRIPT_ACTOR, result.userId, "ADMIN", NOW.toISOString()],
  );
  const text = JSON.stringify(result.log);
  for (const secret of [PW, "bcrypt-hash", "admin@arch.test"]) assert.ok(!text.includes(secret), secret);
});

test("uses an existing organization with the same code AND name; refuses the same code under another name", async () => {
  const fake = new FakeDb();
  fake.orgs.push({ id: "o-existing", code: "ARCH", name: "Arch Engineering Services" });
  const { opts } = options();
  const result = await createFirstAdmin(input(), fake.db, opts);
  assert.ok(result.outcome === "created");
  assert.equal(result.organizationId, "o-existing");
  assert.equal(result.organizationCreated, false);
  assert.equal(fake.orgs.length, 1);

  const other = new FakeDb();
  other.orgs.push({ id: "o-x", code: "ARCH", name: "Someone Else" });
  await assert.rejects(
    createFirstAdmin(input(), other.db, options().opts),
    (e: unknown) => e instanceof FirstAdminRefusalError && e.code === "FIRST_ADMIN_ORG_NAME_MISMATCH",
  );
  assert.equal(other.users.length, 0);
});

test("refuses when an active ADMIN exists in ANY organization - nothing written, nothing updated", async () => {
  const fake = new FakeDb();
  fake.orgs.push({ id: "o9", code: "OTHER", name: "Other" });
  fake.users.push({ id: "x", organizationId: "o9", email: "boss@other.test", role: "ADMIN", active: true, name: "Boss", passwordHash: "h" });
  const before = JSON.stringify([fake.users, fake.orgs]);
  await assert.rejects(
    createFirstAdmin(input(), fake.db, options().opts),
    (e: unknown) => e instanceof FirstAdminRefusalError && e.code === "FIRST_ADMIN_ADMIN_EXISTS",
  );
  assert.equal(JSON.stringify([fake.users, fake.orgs]), before);
});

test("an INACTIVE admin does not count; an existing email (any case, inactive too) is refused and never updated", async () => {
  const fake = new FakeDb();
  fake.users.push({ id: "old", organizationId: "o9", email: "ADMIN@arch.test", role: "ADMIN", active: false, name: "Old", passwordHash: "old-hash" });
  await assert.rejects(
    createFirstAdmin(input(), fake.db, options().opts),
    (e: unknown) => e instanceof FirstAdminRefusalError && e.code === "FIRST_ADMIN_EMAIL_EXISTS",
  );
  assert.deepEqual(fake.users[0], { id: "old", organizationId: "o9", email: "ADMIN@arch.test", role: "ADMIN", active: false, name: "Old", passwordHash: "old-hash" });
  assert.equal(fake.orgs.length, 0);
});

test("password: at least 16 characters, at most 72 bytes, typed twice - checked before any database access", async () => {
  for (const [password, confirmation, code] of [
    ["fifteen-chars!!", "fifteen-chars!!", "USER_ADMIN_PASSWORD_TOO_SHORT"],
    ["x".repeat(73), "x".repeat(73), "USER_ADMIN_PASSWORD_TOO_LONG"],
    [PW, `${PW}x`, "USER_ADMIN_PASSWORD_MISMATCH"],
  ] as const) {
    const fake = new FakeDb();
    const { hashed, opts } = options();
    await assert.rejects(
      createFirstAdmin(input({ password, passwordConfirmation: confirmation }), fake.db, opts),
      (e: unknown) => e instanceof UserAdminRefusalError && e.code === code,
    );
    assert.deepEqual(fake.ops, []);
    assert.deepEqual(hashed, []);
  }
});

test("dry run: every check runs, nothing is hashed or written", async () => {
  const fake = new FakeDb();
  const { hashed, opts } = options({ dryRun: true });
  const result = await createFirstAdmin(input(), fake.db, opts);
  assert.deepEqual(result, { outcome: "dry-run", email: "admin@arch.test", organizationCode: "ARCH", organizationExists: false });
  assert.deepEqual(hashed, []);
  assert.deepEqual(fake.ops, ["begin", "find-admin", "email-check", "find-org", "commit"]);
  assert.equal(fake.users.length + fake.orgs.length, 0);

  const withAdmin = new FakeDb();
  withAdmin.users.push({ id: "x", organizationId: "o", email: "a@b.io", role: "ADMIN", active: true, name: "A", passwordHash: "h" });
  await assert.rejects(
    createFirstAdmin(input(), withAdmin.db, options({ dryRun: true }).opts),
    (e: unknown) => e instanceof FirstAdminRefusalError && e.code === "FIRST_ADMIN_ADMIN_EXISTS",
  );
});

test("two concurrent runs: exactly one administrator is created; the retry of the other is refused", async () => {
  const fake = new FakeDb();
  fake.interleave = () => createFirstAdmin(input({ email: "first@arch.test" }), fake.db, options().opts);
  await assert.rejects(
    createFirstAdmin(input({ email: "second@arch.test" }), fake.db, options().opts),
    (e: unknown) => e instanceof FirstAdminRefusalError && e.code === "FIRST_ADMIN_ADMIN_EXISTS",
  );
  assert.deepEqual(fake.users.map((u) => u.email), ["first@arch.test"]);
});

test("retry exhausted -> CONCURRENT_CHANGES, nothing written", async () => {
  const fake = new FakeDb();
  fake.conflictsToThrow = 3;
  await assert.rejects(
    createFirstAdmin(input(), fake.db, options().opts),
    (e: unknown) => e instanceof ActionRefusalError && e.code === "CONCURRENT_CHANGES",
  );
  assert.equal(fake.users.length + fake.orgs.length, 0);
});

// ------------------------------------------------------------
// Source checks: the script and the wrapper
// ------------------------------------------------------------

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("script: password only from STDIN (never argv / environment), never printed; target database verified before the rules run", () => {
  const script = source("../scripts/create-first-admin.ts");
  assert.doesNotMatch(script, /process\.env/);
  assert.match(script, /process\.stdin\.isTTY/);
  for (const line of script.split(/\r?\n/).filter((l) => /console\.(log|error|info|warn)/.test(l))) {
    // No interpolated value that could hold the password or its hash.
    assert.doesNotMatch(line, /\$\{[^}]*(secret|password|hash)/i, line);
    assert.doesNotMatch(line, /\b(secrets|passwordConfirmation)\b/, line);
  }
  const verify = script.indexOf("target.db !== args.expectedDatabase");
  const create = script.indexOf("await createFirstAdmin(");
  assert.ok(verify > 0 && create > verify, "target check comes first");
});

function lfSha256(path: string): string {
  const bytes = readFileSync(new URL(path, import.meta.url));
  return createHash("sha256").update(Buffer.from(bytes.filter((b) => b !== 13))).digest("hex").toUpperCase();
}

test("wrapper: hidden prompt twice, STDIN only, SENT gate for a real run, ASCII only - and every pinned hash matches the file", () => {
  const wrapper = source("../scripts/create-first-admin.ps1");
  assert.equal((wrapper.match(/= Read-Host -AsSecureString/g) ?? []).length, 2);
  assert.match(wrapper, /\$psi\.RedirectStandardInput = \$true/);
  assert.match(wrapper, /if \(\$answer -cne 'SENT'\)/);
  // C4-L2: the hash the go cites uses the same LF rule as the pins.
  assert.match(wrapper, /\$selfHash = Get-LfSha256 -Path \$PSCommandPath/);
  // C4-L1: an early exit of the script cannot kill the wrapper before the evidence is written.
  assert.match(wrapper, /catch \[System\.IO\.IOException\]/);
  assert.ok(wrapper.indexOf("catch [System.IO.IOException]") < wrapper.indexOf("WriteAllLines($evidencePath"));
  assert.doesNotMatch(wrapper, /\$env:\w*(PASS|PWD|SECRET)/i);
  assert.doesNotMatch(wrapper, /'--password'/);
  assert.ok(![...wrapper].some((c) => c.charCodeAt(0) > 127), "PowerShell 5.1 reads a BOM-less script as ANSI");
  // Rule 7: no function named after an external command.
  for (const [, fn] of wrapper.matchAll(/^function ([\w-]+)/gm)) {
    assert.ok(!/^(node|git|psql|npm|npx)$/i.test(fn), fn);
  }
  const pins = [...wrapper.matchAll(/^\s+'([\w/.-]+)'\s+=\s+'([0-9A-F]{64}|PIN_\w+)'/gm)];
  assert.equal(pins.length, 5);
  for (const [, file, pinned] of pins) {
    assert.equal(pinned, lfSha256(`../${file}`), `pinned hash of ${file}`);
  }
});
