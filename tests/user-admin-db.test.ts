/**
 * B05 user administration - database layer (app/lib/user-admin-db.ts) with an
 * in-memory fake database.
 *   node --experimental-strip-types --test tests/user-admin-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  changeUserRoleForAdmin,
  createUserForAdmin,
  deactivateUserForAdmin,
  reactivateUserForAdmin,
  resetUserPasswordForAdmin,
  unlockSignInForAdmin,
  type UserAdminActor,
  type UserAdminDb,
  type UserAdminOptions,
} from "../app/lib/user-admin-db.ts";
import { UserAdminRefusalError, type UserAdminLogEntry } from "../app/lib/user-admin-core.ts";
import { ActionRefusalError } from "../app/lib/action-notice-core.ts";
import { LoginThrottle, loginThrottleKey } from "../app/lib/login-throttle-core.ts";

type Role = "ADMIN" | "ENGINEER" | "DESIGNER" | "REVIEWER" | "APPROVER" | "VIEWER";

interface FakeUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  passwordHash: string | null;
}

interface FakeSession {
  id: string;
  organizationId: string;
  userId: string;
  revokedAt: Date | null;
}

class SerializationConflict extends Error {
  readonly code = "P2034";
}

/** PostgreSQL ILIKE with the default escape character "\". */
function ilike(value: string, pattern: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") source += "[\\s\\S]*";
    else if (c === "_") source += "[\\s\\S]";
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i").test(value);
}

class FakeDb {
  users: FakeUser[] = [];
  sessions: FakeSession[] = [];
  readonly ops: string[] = [];
  readonly isolationLevels: unknown[] = [];
  /** Throw a serialization conflict at the lock for this many attempts. */
  conflictsToThrow = 0;
  /** Runs once, at the start of the next transaction, as a concurrent
   *  transaction that commits first; that attempt then hits a conflict. */
  interleave: (() => Promise<unknown>) | null = null;
  #nextId = 1;

  get db(): UserAdminDb {
    return {
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>, opts?: { isolationLevel?: unknown }) => {
        const hook = this.interleave;
        this.interleave = null;
        if (hook) await hook();
        let conflict = hook !== null;
        if (!conflict && this.conflictsToThrow > 0) {
          this.conflictsToThrow -= 1;
          conflict = true;
        }
        this.isolationLevels.push(opts?.isolationLevel);
        this.ops.push("begin");
        const users = this.users.map((u) => ({ ...u }));
        const sessions = this.sessions.map((s) => ({ ...s }));
        try {
          const result = await fn(this.#tx(conflict));
          this.ops.push("commit");
          return result;
        } catch (error) {
          this.users = users;
          this.sessions = sessions;
          this.ops.push("rollback");
          throw error;
        }
      }) as unknown as UserAdminDb["$transaction"],
    };
  }

  #tx(conflict: boolean) {
    return {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR UPDATE")) {
          this.ops.push("lock-admins");
          assert.match(sql, /"role" = 'ADMIN'/);
          assert.match(sql, /ORDER BY "id"/);
          if (conflict) throw new SerializationConflict("could not serialize access");
          const [organizationId] = values as string[];
          return this.users
            .filter((u) => u.organizationId === organizationId && u.role === "ADMIN" && u.active)
            .map((u) => ({ id: u.id }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
        }
        if (sql.includes("ILIKE")) {
          this.ops.push("email-check");
          const [email] = values as string[];
          const hit = this.users.find(
            (u) => u.email.toLowerCase() === email || ilike(u.email, email) || ilike(email, u.email),
          );
          return hit ? [{ id: hit.id }] : [];
        }
        throw new Error(`unexpected raw SQL: ${sql}`);
      },
      user: {
        findFirst: async (args: { where: { id: string; organizationId: string } }) => {
          this.ops.push("find-target");
          const u = this.users.find(
            (x) => x.id === args.where.id && x.organizationId === args.where.organizationId,
          );
          return u ? { id: u.id, role: u.role, active: u.active, email: u.email } : null;
        },
        updateMany: async (args: {
          where: { id: string; organizationId: string };
          data: Partial<FakeUser>;
        }) => {
          this.ops.push(`update-user:${Object.keys(args.data).sort().join(",")}`);
          const u = this.users.find(
            (x) => x.id === args.where.id && x.organizationId === args.where.organizationId,
          );
          if (!u) return { count: 0 };
          Object.assign(u, args.data);
          return { count: 1 };
        },
        create: async (args: { data: Omit<FakeUser, "id"> }) => {
          this.ops.push("create-user");
          if (this.users.some((u) => u.organizationId === args.data.organizationId && u.email === args.data.email)) {
            throw Object.assign(new Error("unique"), { code: "P2002" });
          }
          const user = { id: `n${this.#nextId++}`, ...args.data };
          this.users.push(user);
          return { id: user.id };
        },
      },
      desktopSession: {
        updateMany: async (args: {
          where: { organizationId: string; userId: string; revokedAt: null };
          data: { revokedAt: Date };
        }) => {
          this.ops.push("revoke-desktop");
          let count = 0;
          for (const s of this.sessions) {
            if (s.organizationId === args.where.organizationId && s.userId === args.where.userId && s.revokedAt === null) {
              s.revokedAt = args.data.revokedAt;
              count += 1;
            }
          }
          return { count };
        },
      },
    };
  }
}

const NOW = new Date("2026-11-20T12:00:00.000Z");
const PW = "a-good-new-password";

function setup() {
  const fake = new FakeDb();
  fake.users = [
    { id: "a1", organizationId: "o1", email: "admin1@arch.test", name: "Admin 1", role: "ADMIN", active: true, passwordHash: "h-a1" },
    { id: "a2", organizationId: "o1", email: "admin2@arch.test", name: "Admin 2", role: "ADMIN", active: true, passwordHash: "h-a2" },
    { id: "e1", organizationId: "o1", email: "eng1@arch.test", name: "Eng 1", role: "ENGINEER", active: true, passwordHash: "h-e1" },
    { id: "i1", organizationId: "o1", email: "old@arch.test", name: "Old", role: "VIEWER", active: false, passwordHash: "h-i1" },
    { id: "x1", organizationId: "o2", email: "other@else.test", name: "Other", role: "ENGINEER", active: true, passwordHash: "h-x1" },
  ];
  fake.sessions = [
    { id: "s1", organizationId: "o1", userId: "e1", revokedAt: null },
    { id: "s2", organizationId: "o1", userId: "e1", revokedAt: null },
    { id: "s3", organizationId: "o1", userId: "e1", revokedAt: new Date("2026-11-01T00:00:00Z") },
    { id: "s4", organizationId: "o1", userId: "a2", revokedAt: null },
  ];
  const logs: UserAdminLogEntry[] = [];
  const hashed: string[] = [];
  const options: UserAdminOptions = {
    log: (entry) => logs.push(entry),
    now: () => NOW,
    hashPassword: async (pw) => {
      hashed.push(pw);
      return `bcrypt(${hashed.length})`;
    },
  };
  return { fake, logs, hashed, options };
}

const admin1: UserAdminActor = { userId: "a1", organizationId: "o1", role: "ADMIN" };
const admin2: UserAdminActor = { userId: "a2", organizationId: "o1", role: "ADMIN" };
const engineer: UserAdminActor = { userId: "e1", organizationId: "o1", role: "ENGINEER" };

function refusedWith(code: string) {
  return (error: unknown) =>
    (error instanceof UserAdminRefusalError || error instanceof ActionRefusalError) && error.code === code;
}

function assertNoSecrets(logs: UserAdminLogEntry[], ...secrets: string[]) {
  const text = JSON.stringify(logs);
  for (const s of secrets) assert.ok(!text.includes(s), `log must not contain ${s}`);
}

// ------------------------------------------------------------
// U1 create
// ------------------------------------------------------------

test("U1 create: normalized email, hashed password, one committed log line after the commit", async () => {
  const { fake, logs, hashed, options } = setup();
  const result = await createUserForAdmin(
    admin1,
    { email: "  New.User@Arch.TEST ", name: " New User ", role: "DESIGNER", password: PW, passwordConfirmation: PW },
    fake.db,
    options,
  );
  const created = fake.users.find((u) => u.id === result.userId)!;
  assert.deepEqual(
    { ...created },
    { id: result.userId, organizationId: "o1", email: "new.user@arch.test", name: "New User", role: "DESIGNER", active: true, passwordHash: "bcrypt(1)" },
  );
  assert.deepEqual(hashed, [PW]);
  assert.deepEqual(fake.ops, ["begin", "lock-admins", "email-check", "create-user", "commit"]);
  assert.deepEqual(fake.isolationLevels, ["Serializable"]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, "committed");
  assert.equal(logs[0].action, "create_user");
  assert.equal(logs[0].targetUserId, result.userId);
  assert.equal(logs[0].newRole, "DESIGNER");
  assertNoSecrets(logs, PW, "bcrypt(1)", "new.user@arch.test", "New User");
});

test("G-3: an existing address in another organization, another letter case, or on an inactive user is refused", async () => {
  for (const email of ["OTHER@else.test", "Admin1@Arch.Test", "old@arch.test"]) {
    const { fake, logs, options } = setup();
    const before = fake.users.length;
    await assert.rejects(
      createUserForAdmin(admin1, { email, name: "Dup", role: "VIEWER", password: PW, passwordConfirmation: PW }, fake.db, options),
      refusedWith("USER_ADMIN_EMAIL_EXISTS"),
      email,
    );
    assert.equal(fake.users.length, before);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].outcome, "refused");
    assert.equal(logs[0].code, "USER_ADMIN_EMAIL_EXISTS");
  }
});

test("G-3: an address that would match another as an ILIKE sign-in input is refused, both directions", async () => {
  for (const [existing, requested] of [
    ["a_b@arch.test", "axb@arch.test"],
    ["axb@arch.test", "a_b@arch.test"],
  ]) {
    const { fake, options } = setup();
    fake.users.push({ id: "w1", organizationId: "o2", email: existing, name: "W", role: "VIEWER", active: true, passwordHash: "h" });
    await assert.rejects(
      createUserForAdmin(admin1, { email: requested, name: "W2", role: "VIEWER", password: PW, passwordConfirmation: PW }, fake.db, options),
      refusedWith("USER_ADMIN_EMAIL_EXISTS"),
      `${existing} vs ${requested}`,
    );
  }
});

test("G-3: two concurrent creates of the same address - exactly one user exists", async () => {
  const { fake, logs, options } = setup();
  fake.interleave = () =>
    createUserForAdmin(admin2, { email: "same@arch.test", name: "First", role: "VIEWER", password: PW, passwordConfirmation: PW }, fake.db, options);
  await assert.rejects(
    createUserForAdmin(admin1, { email: "Same@arch.test", name: "Second", role: "VIEWER", password: PW, passwordConfirmation: PW }, fake.db, options),
    refusedWith("USER_ADMIN_EMAIL_EXISTS"),
  );
  assert.equal(fake.users.filter((u) => u.email === "same@arch.test").length, 1);
  assert.deepEqual(logs.map((l) => `${l.actorUserId}:${l.outcome}`), ["a2:committed", "a1:refused"]);
});

test("input is validated before any hash or transaction; a password is never hashed when refused", async () => {
  const { fake, hashed, options } = setup();
  await assert.rejects(
    createUserForAdmin(admin1, { email: "ok@arch.test", name: "Ok", role: "VIEWER", password: PW, passwordConfirmation: "different-password" }, fake.db, options),
    refusedWith("USER_ADMIN_PASSWORD_MISMATCH"),
  );
  await assert.rejects(
    createUserForAdmin(admin1, { email: "ok@arch.test", name: "Ok", role: "OWNER", password: PW, passwordConfirmation: PW }, fake.db, options),
    refusedWith("USER_ADMIN_ROLE_INVALID"),
  );
  assert.deepEqual(hashed, []);
  assert.deepEqual(fake.ops, []);
});

// ------------------------------------------------------------
// AC1: only an active ADMIN, re-checked in the database
// ------------------------------------------------------------

const ALL_ACTIONS: Array<[string, (actor: UserAdminActor, db: UserAdminDb, o: UserAdminOptions) => Promise<unknown>]> = [
  ["create", (a, db, o) => createUserForAdmin(a, { email: "z@arch.test", name: "Z", role: "ADMIN", password: PW, passwordConfirmation: PW }, db, o)],
  ["role", (a, db, o) => changeUserRoleForAdmin(a, "e1", "ADMIN", db, o)],
  ["deactivate", (a, db, o) => deactivateUserForAdmin(a, "e1", "yes", db, o)],
  ["reactivate", (a, db, o) => reactivateUserForAdmin(a, "i1", PW, PW, db, o)],
  ["reset", (a, db, o) => resetUserPasswordForAdmin(a, "e1", PW, PW, db, o)],
  ["unlock", (a, db, o) => unlockSignInForAdmin(a, "e1", db, o)],
];

test("AC1: a non-admin actor is refused before any read or write, and the refusal is logged", async () => {
  for (const [name, call] of ALL_ACTIONS) {
    const { fake, logs, hashed, options } = setup();
    const snapshot = JSON.stringify([fake.users, fake.sessions]);
    await assert.rejects(call(engineer, fake.db, options), refusedWith("USER_ADMIN_NOT_ADMIN"), name);
    assert.deepEqual(fake.ops, [], name);
    assert.deepEqual(hashed, [], name);
    assert.equal(JSON.stringify([fake.users, fake.sessions]), snapshot, name);
    assert.equal(logs.length, 1, name);
    assert.deepEqual([logs[0].outcome, logs[0].code, logs[0].actorUserId], ["refused", "USER_ADMIN_NOT_ADMIN", "e1"], name);
  }
});

test("AC1 / B05-M2: a session that still says ADMIN but the database no longer does is refused inside the transaction", async () => {
  for (const [name, call] of ALL_ACTIONS) {
    const { fake, logs, options } = setup();
    fake.users.find((u) => u.id === "a2")!.role = "VIEWER"; // demoted since sign-in
    const snapshot = JSON.stringify([fake.users, fake.sessions]);
    await assert.rejects(call(admin2, fake.db, options), refusedWith("USER_ADMIN_NOT_ADMIN"), name);
    assert.deepEqual(fake.ops, ["begin", "lock-admins", "rollback"], name);
    assert.equal(JSON.stringify([fake.users, fake.sessions]), snapshot, name);
    assert.equal(logs[0].code, "USER_ADMIN_NOT_ADMIN", name);
  }
});

test("tenant: a target in another organization is 'not found' and nothing changes", async () => {
  const calls: Array<(o: UserAdminOptions, db: UserAdminDb) => Promise<unknown>> = [
    (o, db) => changeUserRoleForAdmin(admin1, "x1", "VIEWER", db, o),
    (o, db) => deactivateUserForAdmin(admin1, "x1", "yes", db, o),
    (o, db) => reactivateUserForAdmin(admin1, "x1", PW, PW, db, o),
    (o, db) => resetUserPasswordForAdmin(admin1, "x1", PW, PW, db, o),
    (o, db) => unlockSignInForAdmin(admin1, "x1", db, o),
  ];
  for (const call of calls) {
    const { fake, options } = setup();
    const snapshot = JSON.stringify([fake.users, fake.sessions]);
    await assert.rejects(call(options, fake.db), refusedWith("USER_ADMIN_USER_NOT_FOUND"));
    assert.equal(JSON.stringify([fake.users, fake.sessions]), snapshot);
  }
});

// ------------------------------------------------------------
// U2 role, U3 deactivate / reactivate, AC3
// ------------------------------------------------------------

test("U2: role change is written and logged with old and new role", async () => {
  const { fake, logs, options } = setup();
  await changeUserRoleForAdmin(admin1, "e1", "APPROVER", fake.db, options);
  assert.equal(fake.users.find((u) => u.id === "e1")!.role, "APPROVER");
  assert.deepEqual([logs[0].oldRole, logs[0].newRole, logs[0].targetUserId], ["ENGINEER", "APPROVER", "e1"]);
});

test("self-protection: no self-demotion, no self-deactivation, no same-role change", async () => {
  const { fake, logs, options } = setup();
  await assert.rejects(changeUserRoleForAdmin(admin1, "a1", "VIEWER", fake.db, options), refusedWith("USER_ADMIN_SELF_ROLE"));
  await assert.rejects(deactivateUserForAdmin(admin1, "a1", "yes", fake.db, options), refusedWith("USER_ADMIN_SELF_DEACTIVATE"));
  await assert.rejects(changeUserRoleForAdmin(admin1, "e1", "ENGINEER", fake.db, options), refusedWith("USER_ADMIN_NO_CHANGE"));
  assert.equal(fake.users.find((u) => u.id === "a1")!.role, "ADMIN");
  assert.deepEqual(logs.map((l) => [l.code, l.targetUserId]), [
    ["USER_ADMIN_SELF_ROLE", "a1"],
    ["USER_ADMIN_SELF_DEACTIVATE", "a1"],
    ["USER_ADMIN_NO_CHANGE", "e1"],
  ]);
});

test("AC3: two admins demoting each other concurrently - exactly one succeeds, the retry of the other is refused", async () => {
  const { fake, logs, options } = setup();
  fake.interleave = () => changeUserRoleForAdmin(admin2, "a1", "ENGINEER", fake.db, options);
  await assert.rejects(changeUserRoleForAdmin(admin1, "a2", "ENGINEER", fake.db, options), refusedWith("USER_ADMIN_NOT_ADMIN"));
  const admins = fake.users.filter((u) => u.organizationId === "o1" && u.role === "ADMIN" && u.active);
  assert.deepEqual(admins.map((u) => u.id), ["a2"]);
  assert.deepEqual(logs.map((l) => `${l.actorUserId}:${l.outcome}:${l.code}`), [
    "a2:committed:null",
    "a1:refused:USER_ADMIN_NOT_ADMIN",
  ]);
});

test("AC3: two admins deactivating each other concurrently - one active admin remains", async () => {
  const { fake, options } = setup();
  fake.interleave = () => deactivateUserForAdmin(admin2, "a1", "yes", fake.db, options);
  await assert.rejects(deactivateUserForAdmin(admin1, "a2", "yes", fake.db, options), refusedWith("USER_ADMIN_NOT_ADMIN"));
  assert.deepEqual(
    fake.users.filter((u) => u.role === "ADMIN" && u.active).map((u) => u.id),
    ["a2"],
  );
});

test("U3 deactivate: revokes every open desktop session of that user in the same transaction (AC2)", async () => {
  const { fake, logs, options } = setup();
  const result = await deactivateUserForAdmin(admin1, "e1", "yes", fake.db, options);
  assert.equal(result.desktopSessionsRevoked, 2);
  assert.equal(fake.users.find((u) => u.id === "e1")!.active, false);
  assert.deepEqual(
    fake.sessions.map((s) => [s.id, s.revokedAt?.toISOString() ?? null]),
    [
      ["s1", NOW.toISOString()],
      ["s2", NOW.toISOString()],
      ["s3", "2026-11-01T00:00:00.000Z"],
      ["s4", null],
    ],
  );
  assert.deepEqual(fake.ops, ["begin", "lock-admins", "find-target", "update-user:active", "revoke-desktop", "commit"]);
  assert.deepEqual([logs[0].oldActive, logs[0].newActive, logs[0].desktopSessionsRevoked], [true, false, 2]);
});

test("U3 deactivate: an already inactive user is 'no change'", async () => {
  const { fake, options } = setup();
  await assert.rejects(deactivateUserForAdmin(admin1, "i1", "yes", fake.db, options), refusedWith("USER_ADMIN_NO_CHANGE"));
});

test("U3 reactivate: requires a new password, sets it, and does not revive revoked desktop sessions (B05-M1)", async () => {
  const { fake, logs, hashed, options } = setup();
  fake.sessions.push({ id: "s5", organizationId: "o1", userId: "i1", revokedAt: new Date("2026-11-02T00:00:00Z") });
  await reactivateUserForAdmin(admin1, "i1", PW, PW, fake.db, options);
  const user = fake.users.find((u) => u.id === "i1")!;
  assert.equal(user.active, true);
  assert.equal(user.passwordHash, "bcrypt(1)");
  assert.deepEqual(hashed, [PW]);
  assert.equal(fake.sessions.find((s) => s.id === "s5")!.revokedAt!.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.deepEqual([logs[0].oldActive, logs[0].newActive], [false, true]);
  assertNoSecrets(logs, PW, "bcrypt(1)");

  const second = setup();
  await assert.rejects(
    reactivateUserForAdmin(admin1, "i1", PW, "", second.fake.db, second.options),
    refusedWith("USER_ADMIN_PASSWORD_MISMATCH"),
  );
  await assert.rejects(
    reactivateUserForAdmin(admin1, "e1", PW, PW, second.fake.db, second.options),
    refusedWith("USER_ADMIN_USER_ACTIVE"),
  );
});

// ------------------------------------------------------------
// U4 reset
// ------------------------------------------------------------

test("U4 reset: new hash, desktop sessions revoked, password never logged", async () => {
  const { fake, logs, options } = setup();
  const result = await resetUserPasswordForAdmin(admin1, "e1", PW, PW, fake.db, options);
  assert.deepEqual(result, { desktopSessionsRevoked: 2, selfReset: false });
  assert.equal(fake.users.find((u) => u.id === "e1")!.passwordHash, "bcrypt(1)");
  assert.equal(logs[0].action, "reset_password");
  assertNoSecrets(logs, PW, "bcrypt(1)", "h-e1");
});

test("U4 reset of one's own password is allowed and reported as selfReset (Codex I-2)", async () => {
  const { fake, options } = setup();
  const result = await resetUserPasswordForAdmin(admin1, "a1", PW, PW, fake.db, options);
  assert.equal(result.selfReset, true);
});

test("U4 reset of a deactivated user is refused (reactivate instead)", async () => {
  const { fake, options } = setup();
  await assert.rejects(resetUserPasswordForAdmin(admin1, "i1", PW, PW, fake.db, options), refusedWith("USER_ADMIN_USER_INACTIVE"));
  assert.equal(fake.users.find((u) => u.id === "i1")!.passwordHash, "h-i1");
});

// ------------------------------------------------------------
// Retry
// ------------------------------------------------------------

test("a transient serialization conflict is retried and succeeds", async () => {
  const { fake, logs, options } = setup();
  fake.conflictsToThrow = 1;
  await changeUserRoleForAdmin(admin1, "e1", "VIEWER", fake.db, options);
  assert.equal(fake.users.find((u) => u.id === "e1")!.role, "VIEWER");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, "committed");
});

test("retry exhausted -> CONCURRENT_CHANGES, nothing written, one refused log line", async () => {
  const { fake, logs, options } = setup();
  fake.conflictsToThrow = 3;
  const snapshot = JSON.stringify([fake.users, fake.sessions]);
  await assert.rejects(deactivateUserForAdmin(admin1, "e1", "yes", fake.db, options), refusedWith("CONCURRENT_CHANGES"));
  assert.equal(JSON.stringify([fake.users, fake.sessions]), snapshot);
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0].outcome, logs[0].code], ["refused", "CONCURRENT_CHANGES"]);
});

// ------------------------------------------------------------
// Source checks (in addition to the behavioural tests)
// ------------------------------------------------------------

test("source: the db layer never reads FormData; sign-in and getActor carry and check pwv", () => {
  const db = readFileSync(new URL("../app/lib/user-admin-db.ts", import.meta.url), "utf8");
  assert.ok(!/formData|FormData/.test(db.replace(/^\s*\*.*$/gm, "")));
  const authz = readFileSync(new URL("../app/lib/authz.ts", import.meta.url), "utf8");
  assert.match(authz, /passwordVersionMatches\(session\?\.user\?\.pwv, user\.passwordHash\)/);
  const authTs = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
  assert.match(authTs, /pwv: passwordVersion\(user\.passwordHash\)/);
  assert.match(authTs, /token\.pwv = user\.pwv/);
  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(login, /if \(await getActor\(\)\)/);
});

test("C2-L2: deactivation without the confirmation is refused before any write; a non-admin is still NOT_ADMIN", async () => {
  for (const confirmation of [undefined, null, "", "on", "YES", "true"]) {
    const { fake, logs, options } = setup();
    await assert.rejects(
      deactivateUserForAdmin(admin1, "e1", confirmation, fake.db, options),
      refusedWith("USER_ADMIN_CONFIRM_REQUIRED"),
      String(confirmation),
    );
    assert.deepEqual(fake.ops, []);
    assert.equal(fake.users.find((u) => u.id === "e1")!.active, true);
    assert.deepEqual([logs[0].code, logs[0].targetUserId], ["USER_ADMIN_CONFIRM_REQUIRED", "e1"]);
  }
  const { fake, logs, options } = setup();
  await assert.rejects(deactivateUserForAdmin(engineer, "e1", undefined, fake.db, options), refusedWith("USER_ADMIN_NOT_ADMIN"));
  assert.equal(logs[0].code, "USER_ADMIN_NOT_ADMIN");
});

// ------------------------------------------------------------
// U5 unlock sign-in (G-4)
// ------------------------------------------------------------

function lockedThrottle(...emails: string[]) {
  const throttle = new LoginThrottle(undefined, () => NOW.getTime());
  for (const email of emails) {
    const key = loginThrottleKey(email);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(throttle.beginAttempt(key).allowed, true);
      throttle.recordFailure(key);
    }
  }
  return throttle;
}

test("U5: an admin unlocks a locked user (sign-in's own key), one committed log line, nothing written to the database", async () => {
  const { fake, logs, options } = setup();
  const throttle = lockedThrottle("eng1@arch.test", "admin2@arch.test");
  const result = await unlockSignInForAdmin(admin1, "e1", fake.db, { ...options, throttle });
  assert.deepEqual(result, { wasLocked: true });
  assert.equal(throttle.check(loginThrottleKey(" ENG1@arch.test ")).allowed, true);
  assert.equal(throttle.check(loginThrottleKey("admin2@arch.test")).allowed, false, "other users stay locked");
  assert.deepEqual(fake.ops, ["begin", "lock-admins", "find-target", "commit"]);
  assert.deepEqual([logs[0].action, logs[0].outcome, logs[0].targetUserId], ["unlock_sign_in", "committed", "e1"]);
  assertNoSecrets(logs, "eng1@arch.test");

  const again = await unlockSignInForAdmin(admin1, "e1", fake.db, { ...options, throttle });
  assert.deepEqual(again, { wasLocked: false });
});

test("U5: refused or rolled-back attempts never touch the throttle (the unlock runs only after the commit - I-1)", async () => {
  const cases: Array<[string, (o: UserAdminOptions, db: UserAdminDb, fake: FakeDb) => Promise<unknown>]> = [
    ["non-admin", (o, db) => unlockSignInForAdmin(engineer, "e1", db, o)],
    ["demoted admin", (o, db, fake) => {
      fake.users.find((u) => u.id === "a2")!.role = "VIEWER";
      return unlockSignInForAdmin(admin2, "e1", db, o);
    }],
    ["other organization", (o, db) => unlockSignInForAdmin(admin1, "x1", db, o)],
    ["retry exhausted", (o, db, fake) => {
      fake.conflictsToThrow = 3;
      return unlockSignInForAdmin(admin1, "e1", db, o);
    }],
  ];
  for (const [name, call] of cases) {
    const { fake, logs, options } = setup();
    const throttle = lockedThrottle("eng1@arch.test", "other@else.test");
    await assert.rejects(call({ ...options, throttle }, fake.db, fake), undefined, name);
    assert.equal(throttle.check(loginThrottleKey("eng1@arch.test")).allowed, false, name);
    assert.equal(throttle.check(loginThrottleKey("other@else.test")).allowed, false, name);
    assert.equal(logs.length, 1, name);
    assert.equal(logs[0].outcome, "refused", name);
  }
});
