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
  authenticateDesktopClient,
  resolveDesktopSession,
  revokeDesktopSession,
  type DesktopAuthDb,
} from "../app/lib/desktop-auth-db.ts";
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
      user: {
        findFirst: (async (args: {
          where: { email?: { equals: string }; id?: string; active?: boolean };
        }) => {
          let row: UserRow | undefined;
          if (args.where.email) {
            const target = args.where.email.equals.toLowerCase();
            row = self.users.find((u) => u.email.toLowerCase() === target);
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
