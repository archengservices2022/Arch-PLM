/**
 * Focused tests for desktop bearer-session Prisma wiring
 * (`app/lib/desktop-auth-db.ts`, P4A). Uses an in-memory fake database - no
 * Postgres, no Inventor, no network.
 *
 * Run with:  node --experimental-strip-types --test tests/desktop-auth-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  DesktopAuthError,
  DesktopLoginThrottledError,
  authenticateDesktopClient,
  resolveDesktopSession,
  revokeDesktopSession,
  type DesktopAuthDb,
} from "../app/lib/desktop-auth-db.ts";
import { LoginThrottle, loginThrottleKey as loginThrottleKeyFor } from "../app/lib/login-throttle-core.ts";
import {
  DESKTOP_TOKEN_PREFIX,
  hashDesktopToken,
} from "../app/lib/desktop-auth-core.ts";

const PASSWORD = "correct horse battery staple";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

interface UserRow {
  id: string;
  organizationId: string;
  role: UserRole;
  name: string;
  email: string;
  passwordHash: string | null;
  active: boolean;
  lastLoginAt: Date | null;
}
interface SessionRow {
  id: string;
  organizationId: string;
  userId: string;
  tokenHash: string;
  clientLabel: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
}

class FakeDb {
  readonly users: UserRow[] = [];
  readonly sessions: SessionRow[] = [];
  readonly orgs = new Map<string, { id: string; code: string; name: string }>();
  #seq = 0;

  addOrg(id: string, code = id.toUpperCase(), name = `${id} Inc`): this {
    this.orgs.set(id, { id, code, name });
    return this;
  }
  addUser(row: Partial<UserRow> & { id: string; organizationId: string }): UserRow {
    const full: UserRow = {
      role: UserRole.ENGINEER,
      name: "Test User",
      email: `${row.id}@example.com`,
      passwordHash: PASSWORD_HASH,
      active: true,
      lastLoginAt: null,
      ...row,
    };
    this.users.push(full);
    if (!this.orgs.has(full.organizationId)) this.addOrg(full.organizationId);
    return full;
  }

  get db(): DesktopAuthDb {
    const self = this;
    const orgOf = (organizationId: string) =>
      self.orgs.get(organizationId) ?? { id: organizationId, code: organizationId, name: organizationId };
    return {
      // SIGNIN-EXACT: the sign-in lookup - lower("email") = $1 [AND active], LIMIT 2.
      $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        assert.match(sql, /lower\("email"\) = \?/);
        assert.doesNotMatch(sql, /LIKE/i);
        const target = values[0] as string;
        const activeOnly = /"active" = true/.test(sql);
        return self.users
          .filter((u) => u.email.toLowerCase() === target && (!activeOnly || u.active))
          .slice(0, 2)
          .map((u) => ({ id: u.id }));
      }) as unknown as DesktopAuthDb["$queryRaw"],
      user: {
        findFirst: (async (args: {
          where: { email?: unknown; id?: string; active?: boolean };
        }) => {
          let row: UserRow | undefined;
          if (args.where.email !== undefined) {
            throw new Error("sign-in must not look users up by an email pattern (SIGNIN-EXACT)");
          } else if (args.where.id) {
            row = self.users.find((u) => u.id === args.where.id);
          }
          if (!row) return null;
          if (args.where.active === true && !row.active) return null;
          return {
            id: row.id,
            organizationId: row.organizationId,
            role: row.role,
            name: row.name,
            email: row.email,
            passwordHash: row.passwordHash,
            active: row.active,
            organization: orgOf(row.organizationId),
          };
        }) as unknown as DesktopAuthDb["user"]["findFirst"],
        update: (async (args: { where: { id: string }; data: { lastLoginAt?: Date } }) => {
          const row = self.users.find((u) => u.id === args.where.id);
          if (row && args.data.lastLoginAt) row.lastLoginAt = args.data.lastLoginAt;
          return row;
        }) as unknown as DesktopAuthDb["user"]["update"],
      } as unknown as DesktopAuthDb["user"],
      desktopSession: {
        create: (async (args: { data: Omit<SessionRow, "id" | "revokedAt"> }) => {
          const row: SessionRow = { id: `ds-${++self.#seq}`, revokedAt: null, ...args.data };
          self.sessions.push(row);
          return row;
        }) as unknown as DesktopAuthDb["desktopSession"]["create"],
        findUnique: (async (args: { where: { tokenHash: string } }) => {
          const row = self.sessions.find((s) => s.tokenHash === args.where.tokenHash);
          return row ? { ...row } : null;
        }) as unknown as DesktopAuthDb["desktopSession"]["findUnique"],
        update: (async (args: { where: { id: string }; data: { lastUsedAt?: Date } }) => {
          const row = self.sessions.find((s) => s.id === args.where.id);
          if (row && args.data.lastUsedAt) row.lastUsedAt = args.data.lastUsedAt;
          return row;
        }) as unknown as DesktopAuthDb["desktopSession"]["update"],
        updateMany: (async (args: {
          where: { tokenHash: string; revokedAt: null };
          data: { revokedAt: Date };
        }) => {
          let count = 0;
          for (const s of self.sessions) {
            if (s.tokenHash === args.where.tokenHash && s.revokedAt === null) {
              s.revokedAt = args.data.revokedAt;
              count += 1;
            }
          }
          return { count };
        }) as unknown as DesktopAuthDb["desktopSession"]["updateMany"],
      } as unknown as DesktopAuthDb["desktopSession"],
    } as unknown as DesktopAuthDb;
  }
}

// ------------------------------------------------------------
// authenticateDesktopClient
// ------------------------------------------------------------

test("login: valid credentials mint a prefixed token; only the hash is stored; lastLoginAt set", async () => {
  const fake = new FakeDb().addOrg("orgA", "ORGA", "Org A");
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com", role: UserRole.ENGINEER });

  const res = await authenticateDesktopClient("ENG@orga.com", PASSWORD, "Inventor 2025 on WS-01", fake.db, {
    ttlHours: 12,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.ok(res.token.startsWith(DESKTOP_TOKEN_PREFIX));
  assert.equal(res.tokenType, "Bearer");
  assert.equal(res.expiresAt, new Date("2026-05-01T12:00:00Z").toISOString());
  assert.equal(res.identity.organization.code, "ORGA");
  assert.equal(res.identity.role, "ENGINEER");

  assert.equal(fake.sessions.length, 1);
  const stored = fake.sessions[0]!;
  assert.equal(stored.tokenHash, hashDesktopToken(res.token));
  assert.notEqual(stored.tokenHash, res.token, "raw token must never be stored");
  assert.equal(stored.clientLabel, "Inventor 2025 on WS-01");
  assert.equal(fake.users[0]!.lastLoginAt?.toISOString(), "2026-05-01T00:00:00.000Z");
});

test("login: wrong password -> generic 401, no session created, message leaks nothing", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });

  await assert.rejects(
    () => authenticateDesktopClient("eng@orga.com", "S3cr3t-submitted-pw", null, fake.db),
    (err: unknown) => {
      assert.ok(err instanceof DesktopAuthError);
      assert.equal(err.status, 401);
      // Generic: never echoes the submitted secret or the email, and never
      // says WHICH factor failed.
      assert.ok(!err.message.includes("S3cr3t-submitted-pw"));
      assert.ok(!err.message.includes("eng@orga.com"));
      assert.doesNotMatch(err.message.toLowerCase(), /wrong|incorrect|invalid password|no such|not found/);
      return true;
    },
  );
  assert.equal(fake.sessions.length, 0);
});

test("login: unknown email -> same generic 401 (no user enumeration)", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  await assert.rejects(
    () => authenticateDesktopClient("nobody@nowhere.com", PASSWORD, null, fake.db),
    (err: unknown) => {
      assert.ok(err instanceof DesktopAuthError);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("login: inactive user and passwordless user both -> generic 401", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "inactive", organizationId: "orgA", email: "off@orga.com", active: false });
  fake.addUser({ id: "nopass", organizationId: "orgA", email: "np@orga.com", passwordHash: null });

  for (const email of ["off@orga.com", "np@orga.com"]) {
    await assert.rejects(
      () => authenticateDesktopClient(email, PASSWORD, null, fake.db),
      (err: unknown) => err instanceof DesktopAuthError && err.status === 401,
    );
  }
  assert.equal(fake.sessions.length, 0);
});

test("login: missing fields -> 400", async () => {
  const fake = new FakeDb();
  await assert.rejects(
    () => authenticateDesktopClient(undefined, undefined, null, fake.db),
    (err: unknown) => err instanceof DesktopAuthError && err.status === 400,
  );
});

// ------------------------------------------------------------
// resolveDesktopSession
// ------------------------------------------------------------

async function mint(fake: FakeDb, userId = "u1", now = new Date("2026-05-01T00:00:00Z")) {
  const res = await authenticateDesktopClient(
    fake.users.find((u) => u.id === userId)!.email,
    PASSWORD,
    null,
    fake.db,
    { ttlHours: 12, now },
  );
  return res.token;
}

test("resolve: a fresh token yields an Actor with server-derived tenant + role", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com", role: UserRole.APPROVER });
  const token = await mint(fake);

  const resolved = await resolveDesktopSession(token, fake.db, new Date("2026-05-01T01:00:00Z"));
  assert.ok(resolved);
  assert.deepEqual(resolved!.actor, {
    userId: "u1",
    organizationId: "orgA",
    role: UserRole.APPROVER,
    name: "Test User",
    email: "e@orga.com",
  });
});

test("resolve: expired / revoked / unknown / deactivated all return null", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com" });
  const token = await mint(fake, "u1", new Date("2026-05-01T00:00:00Z"));

  // expired (13h later, ttl was 12h)
  assert.equal(await resolveDesktopSession(token, fake.db, new Date("2026-05-01T13:00:00Z")), null);

  // unknown token
  assert.equal(
    await resolveDesktopSession(`${DESKTOP_TOKEN_PREFIX}deadbeef`, fake.db, new Date("2026-05-01T01:00:00Z")),
    null,
  );

  // revoked
  await revokeDesktopSession(token, fake.db, new Date("2026-05-01T00:30:00Z"));
  assert.equal(await resolveDesktopSession(token, fake.db, new Date("2026-05-01T01:00:00Z")), null);
});

test("resolve: user deactivated AFTER the token was issued -> null", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com" });
  const token = await mint(fake);
  fake.users[0]!.active = false;
  assert.equal(await resolveDesktopSession(token, fake.db, new Date("2026-05-01T01:00:00Z")), null);
});

test("resolve: session/user organization mismatch -> null (defense in depth)", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com" });
  const token = await mint(fake);
  fake.users[0]!.organizationId = "orgB"; // moved orgs; session still says orgA
  fake.addOrg("orgB");
  assert.equal(await resolveDesktopSession(token, fake.db, new Date("2026-05-01T01:00:00Z")), null);
});

test("resolve: lastUsedAt is touched only after the throttle interval", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com" });
  const token = await mint(fake, "u1", new Date("2026-05-01T00:00:00Z"));

  await resolveDesktopSession(token, fake.db, new Date("2026-05-01T00:00:30Z")); // 30s -> no touch
  assert.equal(fake.sessions[0]!.lastUsedAt.toISOString(), "2026-05-01T00:00:00.000Z");

  await resolveDesktopSession(token, fake.db, new Date("2026-05-01T00:05:00Z")); // 5m -> touch
  assert.equal(fake.sessions[0]!.lastUsedAt.toISOString(), "2026-05-01T00:05:00.000Z");
});

// ------------------------------------------------------------
// revokeDesktopSession
// ------------------------------------------------------------

test("revoke: live session -> {revoked:true}; unknown / already-revoked -> {revoked:false}, never throws", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com" });
  const token = await mint(fake);

  assert.deepEqual(await revokeDesktopSession(token, fake.db), { revoked: true });
  assert.deepEqual(await revokeDesktopSession(token, fake.db), { revoked: false });
  assert.deepEqual(await revokeDesktopSession(`${DESKTOP_TOKEN_PREFIX}nope`, fake.db), { revoked: false });
  assert.ok(fake.sessions[0]!.revokedAt instanceof Date);
});

test("no raw token is ever written into a stored session row", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "e@orga.com" });
  const token = await mint(fake);
  const serialized = JSON.stringify(fake.sessions);
  assert.ok(!serialized.includes(token), "the raw bearer token must not appear anywhere in the DB rows");
});

// ------------------------------------------------------------
// WP-2A (2A-1): login throttling on the desktop sign-in path
// ------------------------------------------------------------

function throttleWithClock() {
  let t = Date.UTC(2026, 10, 18, 12, 0, 0);
  const throttle = new LoginThrottle(undefined, () => t);
  return { throttle, advance: (ms: number) => { t += ms; } };
}

test("throttle: the 6th attempt after 5 wrong passwords is refused with 429 + retry-after, even with the RIGHT password; no session", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  const { throttle } = throttleWithClock();

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => authenticateDesktopClient("eng@orga.com", "wrong", null, fake.db, { throttle }),
      (err: unknown) => err instanceof DesktopAuthError && err.status === 401 && !(err instanceof DesktopLoginThrottledError),
    );
  }
  await assert.rejects(
    () => authenticateDesktopClient("eng@orga.com", PASSWORD, null, fake.db, { throttle }),
    (err: unknown) => {
      assert.ok(err instanceof DesktopLoginThrottledError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSeconds, 60);
      // Generic: never says whether the account exists or which factor failed.
      assert.ok(!err.publicMessage.includes("eng@orga.com"));
      assert.doesNotMatch(err.publicMessage.toLowerCase(), /password is|wrong|not found|no such/);
      return true;
    },
  );
  assert.equal(fake.sessions.length, 0, "no session while throttled");
});

test("throttle: after the block expires the right password works, and success resets the counter", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  const { throttle, advance } = throttleWithClock();

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => authenticateDesktopClient("eng@orga.com", "wrong", null, fake.db, { throttle }));
  }
  advance(60_000);
  const res = await authenticateDesktopClient("ENG@orga.com", PASSWORD, null, fake.db, { throttle });
  assert.ok(res.token);
  assert.equal(fake.sessions.length, 1);
  // Counter reset: 4 more wrong attempts are still plain 401s.
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(
      () => authenticateDesktopClient("eng@orga.com", "wrong", null, fake.db, { throttle }),
      (err: unknown) => err instanceof DesktopAuthError && err.status === 401,
    );
  }
});

test("throttle: unknown, inactive and passwordless accounts count as failures too (no enumeration through the throttle)", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "off", organizationId: "orgA", email: "off@orga.com", active: false });
  const { throttle } = throttleWithClock();
  for (const email of ["nobody@nowhere.com", "off@orga.com"]) {
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => authenticateDesktopClient(email, PASSWORD, null, fake.db, { throttle }));
    }
    await assert.rejects(
      () => authenticateDesktopClient(email, PASSWORD, null, fake.db, { throttle }),
      (err: unknown) => err instanceof DesktopLoginThrottledError && err.status === 429,
    );
  }
});

test("throttle (Codex WP2A-H1): 50 PARALLEL wrong-password logins -> only 5 reach the password check (401), 45 refused (429), no session", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  const { throttle } = throttleWithClock();
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () => authenticateDesktopClient("eng@orga.com", "wrong", null, fake.db, { throttle })),
  );
  const statuses = results.map((r) => (r.status === "rejected" && r.reason instanceof DesktopAuthError ? r.reason.status : -1));
  assert.equal(statuses.filter((s) => s === 401).length, 5, "exactly maxFailures password checks");
  assert.equal(statuses.filter((s) => s === 429).length, 45);
  assert.equal(fake.sessions.length, 0);
  assert.equal(throttle.check(loginThrottleKeyFor("eng@orga.com")).allowed, false, "account now blocked");
});

test("throttle (Codex WP2A-H1): a correct password inside a burst succeeds only if its reservation was admitted", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  const { throttle } = throttleWithClock();
  const passwords = [PASSWORD, ...Array.from({ length: 9 }, () => "wrong")];
  const results = await Promise.allSettled(
    passwords.map((pw) => authenticateDesktopClient("eng@orga.com", pw, null, fake.db, { throttle })),
  );
  assert.equal(results[0]!.status, "fulfilled", "the correct password was among the 5 admitted reservations");
  const rest = results.slice(1).map((r) => (r.status === "rejected" && r.reason instanceof DesktopAuthError ? r.reason.status : -1));
  assert.equal(rest.filter((s) => s === 401).length, 4);
  assert.equal(rest.filter((s) => s === 429).length, 5);
  assert.equal(fake.sessions.length, 1);
});

test("throttle: an unexpected database error releases the reservation (no failure counted)", async () => {
  const fake = new FakeDb();
  const { throttle } = throttleWithClock();
  const broken = {
    ...fake.db,
    $queryRaw: async () => { throw new Error("db down"); },
    user: { ...fake.db.user, findFirst: async () => { throw new Error("db down"); } },
  } as unknown as DesktopAuthDb;
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(() => authenticateDesktopClient("eng@orga.com", "x", null, broken, { throttle }), /db down/);
  }
  assert.equal(throttle.size, 0, "nothing counted or reserved after errors");
});

test("throttle: missing fields stay a 400 and are not counted against an account", async () => {
  const fake = new FakeDb();
  const { throttle } = throttleWithClock();
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(
      () => authenticateDesktopClient(undefined, undefined, null, fake.db, { throttle }),
      (err: unknown) => err instanceof DesktopAuthError && err.status === 400,
    );
  }
  assert.equal(throttle.size, 0);
});

// ------------------------------------------------------------
// SIGNIN-EXACT (Codex P-1b): the email is matched exactly (ignoring case),
// never as an ILIKE pattern, so a wildcard input cannot reach another
// account under a throttle key of its own.
// ------------------------------------------------------------

test("SIGNIN-EXACT: wildcard inputs never sign in as an existing user, even with that user's password", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  fake.addUser({ id: "u2", organizationId: "orgA", email: "a_b@orga.com" });
  for (const email of ["%", "%@%", "_%", "%%", "e_g@orga.com", "ENG@ORGA.CO_", "a%@orga.com", "axb@orga.com"]) {
    await assert.rejects(
      () => authenticateDesktopClient(email, PASSWORD, null, fake.db, { throttle: throttleWithClock().throttle }),
      (err: unknown) => err instanceof DesktopAuthError && err.status === 401,
      email,
    );
  }
  assert.equal(fake.sessions.length, 0);
  // The exact address still works, in any letter case.
  const ok = await authenticateDesktopClient(" A_B@OrgA.com ", PASSWORD, null, fake.db, { throttle: throttleWithClock().throttle });
  assert.equal(ok.identity.userId, "u2");
});

test("SIGNIN-EXACT: an ambiguous address (two users, e.g. two organizations) is refused like an unknown one", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "dup@arch.test" });
  fake.addUser({ id: "u2", organizationId: "orgB", email: "DUP@arch.test" });
  await assert.rejects(
    () => authenticateDesktopClient("dup@arch.test", PASSWORD, null, fake.db, { throttle: throttleWithClock().throttle }),
    (err: unknown) => err instanceof DesktopAuthError && err.status === 401,
  );
  assert.equal(fake.sessions.length, 0);
});

test("SIGNIN-EXACT: failures under wildcard inputs do not unlock guessing - the victim's own key is what counts", async () => {
  const fake = new FakeDb();
  fake.addUser({ id: "u1", organizationId: "orgA", email: "eng@orga.com" });
  const { throttle } = throttleWithClock();
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => authenticateDesktopClient("eng@orga.com", "wrong", null, fake.db, { throttle }));
  }
  // Victim blocked; a pattern input neither reaches the victim nor bypasses the block.
  await assert.rejects(
    () => authenticateDesktopClient("eng@orga.com", PASSWORD, null, fake.db, { throttle }),
    (err: unknown) => err instanceof DesktopLoginThrottledError,
  );
  await assert.rejects(
    () => authenticateDesktopClient("e%", PASSWORD, null, fake.db, { throttle }),
    (err: unknown) => err instanceof DesktopAuthError && err.status === 401,
  );
  assert.equal(fake.sessions.length, 0);
});
