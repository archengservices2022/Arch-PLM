/**
 * B05 live integration gate - REAL PostgreSQL concurrency of the user
 * administration rules (app/lib/user-admin-db.ts): SERIALIZABLE + the
 * FOR UPDATE lock on the organization's active ADMIN rows + the bounded retry.
 * Required by the PO-signed B05 plan Rev1 section 4 ("scratch-database itest,
 * as B06's") and cited by A1 Rev5 Step 13 for AC3 (Codex rehearsal review M-1).
 *
 * Not part of `npm test`. Talks to the database directly; no dev server.
 * Throwaway data only (organizations ITEST-B05-*). Passwords: the fixtures use
 * a fixed dummy value and a fake hash - no fixture user can sign in.
 *
 * HOW THE OVERLAP IS FORCED: each action gets its own "lane" - a wrapper
 * around prisma.$transaction. On the lane's FIRST attempt the transaction
 * callback runs `select 1` - a SERIALIZABLE snapshot is taken at the first
 * STATEMENT, not at BEGIN (Codex IT-M1) - and only then waits at a barrier
 * until both lanes hold a snapshot, so both snapshots predate any commit.
 * A lane may also wait for a gate (check 3: until the other action has
 * committed) before the real action body, which starts with the FOR UPDATE
 * lock. Retries skip the snapshot, barrier and gate. Each lane records its
 * attempts and every serialization error seen (Prisma code + SQLSTATE).
 * A check passes only if the outcome is correct AND at least one real
 * serialization conflict was observed (otherwise it was not a concurrency
 * test).
 *
 * SAFETY (same pattern as the B06 gate):
 *  1. BEFORE any connection: DATABASE_URL must be
 *     postgres://...@127.0.0.1|localhost:5432/<db> with no redirecting query
 *     parameters; <db> must equal B05_EXPECTED_DATABASE, match
 *     ^arch_plm_[a-z0-9_]*scratch[a-z0-9_]*$ and not be protected.
 *  2. AFTER connecting, BEFORE any write: current database, server address,
 *     port and system identifier (B05_EXPECTED_SYSTEM_ID) must match; only
 *     ITEST-B05 organizations may exist; the schema of all 19 migrations must
 *     be present (6 append-only triggers, User.passwordHash). If the
 *     connected role cannot run these checks (e.g. no EXECUTE on
 *     pg_control_system), that is also "target not verified" (exit 2).
 *  The PostgreSQL version and transaction_isolation are printed as evidence.
 *
 * Run (DATABASE_URL must point at the scratch database):
 *   B05_EXPECTED_DATABASE=<db> B05_EXPECTED_SYSTEM_ID=<id> \
 *     node --experimental-strip-types scripts/itest-b05-user-admin.ts
 *
 * Exit codes: 0 all checks passed; 1 a check failed; 2 target not verified
 * (nothing written).
 */
import { randomBytes } from "node:crypto";

import { PrismaClient, type Prisma } from "../app/generated/prisma/client.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import { isSerializationError } from "../app/lib/db-concurrency-db.ts";
import { UserAdminRefusalError, type UserAdminLogEntry } from "../app/lib/user-admin-core.ts";
import {
  changeUserRoleForAdmin,
  createUserForAdmin,
  deactivateUserForAdmin,
  DEACTIVATE_CONFIRMATION_VALUE,
  type UserAdminActor,
  type UserAdminDb,
  type UserAdminOptions,
} from "../app/lib/user-admin-db.ts";

const PROTECTED_DATABASES = new Set(["arch_plm", "arch_plm_m3_scratch", "archplm_dev", "postgres", "template0", "template1"]);
const SCRATCH_NAME = /^arch_plm_[a-z0-9_]*scratch[a-z0-9_]*$/;
const EXPECTED_APPEND_ONLY_TRIGGERS = 6;
/** A fixed dummy value (16+ characters) - only to pass input validation. */
const DUMMY_PASSWORD = "itest-b05-dummy-value-0001";
/** Stored instead of a bcrypt hash, so no fixture user can ever sign in. */
const FAKE_HASH = "itest-b05-not-a-bcrypt-hash";

function log(message: string) {
  console.log(message);
}

// ------------------------------------------------------------
// 1. Pre-connection target check (no PrismaClient exists yet)
// ------------------------------------------------------------

function verifyBeforeConnecting(): void {
  const refuse = (why: string): never => {
    log(`TARGET NOT VERIFIED (before connecting): ${why}`);
    process.exit(2);
  };
  const expectedDb = process.env.B05_EXPECTED_DATABASE ?? "";
  if (!process.env.B05_EXPECTED_SYSTEM_ID) refuse("B05_EXPECTED_SYSTEM_ID is required");
  if (!SCRATCH_NAME.test(expectedDb)) refuse(`B05_EXPECTED_DATABASE '${expectedDb}' is not an arch_plm_*scratch* name`);
  if (PROTECTED_DATABASES.has(expectedDb)) refuse(`'${expectedDb}' is protected`);
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    return refuse("DATABASE_URL is missing or not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") refuse(`protocol ${url.protocol}`);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") refuse(`host ${url.hostname} is not loopback`);
  if ((url.port || "5432") !== "5432") refuse(`port ${url.port}`);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (dbName !== expectedDb) refuse(`URL database '${dbName}' != B05_EXPECTED_DATABASE '${expectedDb}'`);
  for (const key of url.searchParams.keys()) {
    if (!["schema", "connection_limit", "pool_timeout", "connect_timeout", "sslmode"].includes(key)) {
      refuse(`URL query parameter '${key}' is not allowed (could redirect the connection)`);
    }
  }
  log(`URL CHECK: postgres @ ${url.hostname}:${url.port || "5432"}/${dbName} (credentials not shown)`);
}

verifyBeforeConnecting();

const prisma = new PrismaClient();

let failed = 0;
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ------------------------------------------------------------
// 2. Post-connection target + schema check (before any write)
// ------------------------------------------------------------

async function verifyTargetAfterConnecting() {
  try {
    await verifyTargetChecks();
  } catch (error) {
    // IT-L2: e.g. the role may not run pg_control_system() - not verified, nothing written.
    log(`TARGET NOT VERIFIED (after connecting): the checks could not run (${error instanceof Error ? error.name : "error"} ${String((error as { code?: unknown }).code ?? "")})`);
    await prisma.$disconnect();
    process.exit(2);
  }
}

async function verifyTargetChecks() {
  const [env] = await prisma.$queryRaw<{ version: string; isolation: string }[]>`
    select current_setting('server_version') as version,
           current_setting('transaction_isolation') as isolation`;
  log(`POSTGRESQL: server_version=${env!.version}; default transaction_isolation=${env!.isolation}`);
  const [row] = await prisma.$queryRaw<
    { db: string; sysid: string; addr: string | null; port: number; foreignOrgs: bigint }[]
  >`select current_database() as db,
           (select system_identifier::text from pg_control_system()) as sysid,
           host(inet_server_addr()) as addr,
           inet_server_port() as port,
           (select count(*) from "Organization" where code not like 'ITEST-B05-%') as "foreignOrgs"`;
  const ok =
    row &&
    row.db === process.env.B05_EXPECTED_DATABASE &&
    row.sysid === process.env.B05_EXPECTED_SYSTEM_ID &&
    (row.addr === "127.0.0.1" || row.addr === "::1") &&
    Number(row.port) === 5432 &&
    Number(row.foreignOrgs) === 0;
  if (!ok) {
    log(`TARGET NOT VERIFIED (after connecting): ${JSON.stringify({ ...row, foreignOrgs: row ? Number(row.foreignOrgs) : null })}`);
    await prisma.$disconnect();
    process.exit(2);
  }
  const [schema] = await prisma.$queryRaw<{ triggers: bigint; pwHash: bigint; anyData: bigint }[]>`
    select (select count(*) from pg_trigger where not tgisinternal and tgname like 'ItemRevision%append_only%') as triggers,
           (select count(*) from information_schema.columns
              where table_name = 'User' and column_name = 'passwordHash') as "pwHash",
           (select count(*) from "Organization") as "anyData"`;
  if (Number(schema!.triggers) !== EXPECTED_APPEND_ONLY_TRIGGERS || Number(schema!.pwHash) !== 1) {
    log(`TARGET NOT VERIFIED: schema incomplete (append-only triggers=${schema!.triggers}, User.passwordHash=${schema!.pwHash})`);
    await prisma.$disconnect();
    process.exit(2);
  }
  log(`TARGET VERIFIED: ${row.db} @ ${row.addr}:${row.port} system_identifier=${row.sysid}; only ITEST-B05 data (${schema!.anyData} organizations); all 19 migrations applied (${EXPECTED_APPEND_ONLY_TRIGGERS} append-only triggers)`);
}

// ------------------------------------------------------------
// Lanes: forced overlap + conflict recording
// ------------------------------------------------------------

/** Opens once `parties` callers have arrived (plain object: node strip-types
 *  does not accept TypeScript parameter properties). */
interface Barrier {
  arrive: () => Promise<void>;
}

function newBarrier(parties: number): Barrier {
  let waiting = 0;
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrive: async () => {
      waiting += 1;
      if (waiting >= parties) release();
      await opened;
    },
  };
}

interface Lane {
  name: string;
  db: UserAdminDb;
  attempts: number;
  conflicts: string[];
}

function describeConflict(error: unknown): string {
  const e = error as { code?: unknown; meta?: { code?: unknown } };
  const pg = e.meta && typeof e.meta === "object" && "code" in e.meta ? `/${String(e.meta.code)}` : "";
  return `${String(e.code)}${pg}`;
}

/** Rejects after `ms` so a gate can never park a lane (Codex question b). */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not open within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lane(name: string, barrier: Barrier, gate?: Promise<unknown>): Lane {
  const state: Lane = { name, attempts: 0, conflicts: [], db: undefined as unknown as UserAdminDb };
  const $transaction = async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: object) => {
    state.attempts += 1;
    const first = state.attempts === 1;
    try {
      return await prisma.$transaction(async (tx) => {
        if (first) {
          // IT-M1: the first statement takes the SERIALIZABLE snapshot - before the barrier.
          await tx.$queryRaw`select 1`;
          await barrier.arrive();
          if (gate) await withTimeout(gate, 15_000, "the gate");
        }
        return fn(tx);
      }, { ...(opts ?? {}), maxWait: 10_000, timeout: 20_000 });
    } catch (error) {
      if (isSerializationError(error)) state.conflicts.push(describeConflict(error));
      throw error;
    }
  };
  state.db = { $transaction } as unknown as UserAdminDb;
  return state;
}

type Outcome = { lane: Lane; result: "committed" | string };

async function run(laneState: Lane, action: () => Promise<unknown>): Promise<Outcome> {
  try {
    await action();
    return { lane: laneState, result: "committed" };
  } catch (error) {
    if (error instanceof UserAdminRefusalError) return { lane: laneState, result: error.code };
    const code = (error as { code?: unknown }).code;
    return { lane: laneState, result: `ERROR ${error instanceof Error ? error.name : "unknown"} ${String(code ?? "")}`.trim() };
  }
}

function report(outcomes: Outcome[]): string {
  return outcomes
    .map((o) => `${o.lane.name}: ${o.result}, attempts=${o.lane.attempts}, conflicts=[${o.lane.conflicts.join(",")}]`)
    .join("; ");
}

function totalConflicts(outcomes: Outcome[]): number {
  return outcomes.reduce((sum, o) => sum + o.lane.conflicts.length, 0);
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const rand = randomBytes(4).toString("hex");
let orgCounter = 0;

async function makeOrg(tag: string) {
  orgCounter += 1;
  return prisma.organization.create({
    data: { name: `ITEST B05 ${tag} ${rand}`, code: `ITEST-B05-${tag}-${rand}-${orgCounter}` },
  });
}

async function makeAdmin(organizationId: string, key: string): Promise<UserAdminActor> {
  const user = await prisma.user.create({
    data: {
      organizationId,
      email: `${key}-${rand}-${orgCounter}@itest-b05.example`,
      name: `B05 ${key}`,
      role: UserRole.ADMIN,
      active: true,
      passwordHash: FAKE_HASH,
    },
  });
  return { userId: user.id, organizationId, role: UserRole.ADMIN };
}

async function activeAdmins(organizationId: string): Promise<number> {
  return prisma.user.count({ where: { organizationId, role: UserRole.ADMIN, active: true } });
}

function options(logs: UserAdminLogEntry[]): UserAdminOptions {
  return { log: (entry) => logs.push(entry), hashPassword: async () => FAKE_HASH };
}

function committedCount(outcomes: Outcome[]): number {
  return outcomes.filter((o) => o.result === "committed").length;
}

// ------------------------------------------------------------
// Checks
// ------------------------------------------------------------

async function main() {
  await verifyTargetAfterConnecting();

  await check("AC3: two admins demote EACH OTHER concurrently -> exactly one succeeds; one active admin remains", async () => {
    const org = await makeOrg("DEMOTE");
    const a = await makeAdmin(org.id, "admin-a");
    const b = await makeAdmin(org.id, "admin-b");
    const barrier = newBarrier(2);
    const la = lane("A demotes B", barrier);
    const lb = lane("B demotes A", barrier);
    const logs: UserAdminLogEntry[] = [];
    const outcomes = await Promise.all([
      run(la, () => changeUserRoleForAdmin(a, b.userId, UserRole.ENGINEER, la.db, options(logs))),
      run(lb, () => changeUserRoleForAdmin(b, a.userId, UserRole.ENGINEER, lb.db, options(logs))),
    ]);
    log(`      ${report(outcomes)}`);
    assert(committedCount(outcomes) === 1, `committed=${committedCount(outcomes)}`);
    const refused = outcomes.find((o) => o.result !== "committed")!;
    assert(["USER_ADMIN_NOT_ADMIN", "USER_ADMIN_LAST_ADMIN"].includes(refused.result), `refusal was ${refused.result}`);
    assert((await activeAdmins(org.id)) === 1, "active admins != 1");
    assert(totalConflicts(outcomes) >= 1, "no serialization conflict observed - the transactions did not overlap");
    assert(logs.filter((l) => l.outcome === "committed").length === 1 && logs.filter((l) => l.outcome === "refused").length === 1, "log lines");
  });

  await check("AC3: two admins deactivate EACH OTHER concurrently -> exactly one succeeds; one active admin remains", async () => {
    const org = await makeOrg("DEACT");
    const a = await makeAdmin(org.id, "admin-a");
    const b = await makeAdmin(org.id, "admin-b");
    const barrier = newBarrier(2);
    const la = lane("A deactivates B", barrier);
    const lb = lane("B deactivates A", barrier);
    const logs: UserAdminLogEntry[] = [];
    const outcomes = await Promise.all([
      run(la, () => deactivateUserForAdmin(a, b.userId, DEACTIVATE_CONFIRMATION_VALUE, la.db, options(logs))),
      run(lb, () => deactivateUserForAdmin(b, a.userId, DEACTIVATE_CONFIRMATION_VALUE, lb.db, options(logs))),
    ]);
    log(`      ${report(outcomes)}`);
    assert(committedCount(outcomes) === 1, `committed=${committedCount(outcomes)}`);
    const refused = outcomes.find((o) => o.result !== "committed")!;
    assert(["USER_ADMIN_NOT_ADMIN", "USER_ADMIN_LAST_ADMIN"].includes(refused.result), `refusal was ${refused.result}`);
    assert((await activeAdmins(org.id)) === 1, "active admins != 1");
    assert(totalConflicts(outcomes) >= 1, "no serialization conflict observed - the transactions did not overlap");
  });

  await check("AC3: an actor demoted while acting -> the actor's action is refused (NOT_ADMIN); its target is unchanged", async () => {
    const org = await makeOrg("ACTOR");
    const a = await makeAdmin(org.id, "admin-a");
    const b = await makeAdmin(org.id, "admin-b");
    const c = await makeAdmin(org.id, "admin-c");
    const barrier = newBarrier(2);
    // IT-M1: B takes its snapshot, then waits until A's demotion has COMMITTED;
    // B's FOR UPDATE then meets a row changed after its snapshot -> 40001; the
    // retry sees B demoted -> NOT_ADMIN. B holds no lock while it waits.
    let openGate: () => void = () => {};
    const aCommitted = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const la = lane("A demotes B", barrier);
    const lb = lane("B deactivates C (after A commits)", barrier, aCommitted);
    const logs: UserAdminLogEntry[] = [];
    const outcomes = await Promise.all([
      run(la, () => changeUserRoleForAdmin(a, b.userId, UserRole.ENGINEER, la.db, options(logs))).finally(() => openGate()),
      run(lb, () => deactivateUserForAdmin(b, c.userId, DEACTIVATE_CONFIRMATION_VALUE, lb.db, options(logs))),
    ]);
    log(`      ${report(outcomes)}`);
    assert(outcomes[0]!.result === "committed", `A's demotion: ${outcomes[0]!.result}`);
    assert(outcomes[1]!.result === "USER_ADMIN_NOT_ADMIN", `B's action: ${outcomes[1]!.result}`);
    const cRow = await prisma.user.findUniqueOrThrow({ where: { id: c.userId }, select: { active: true, role: true } });
    assert(cRow.active && cRow.role === UserRole.ADMIN, "C was changed");
    assert(lb.conflicts.length >= 1, "B saw no serialization conflict - its snapshot did not predate A's commit");
  });

  await check("G-3: the same address created concurrently in TWO organizations (letter case differs) -> exactly one user", async () => {
    const org1 = await makeOrg("DUP1");
    const a = await makeAdmin(org1.id, "admin-1");
    const org2 = await makeOrg("DUP2");
    const x = await makeAdmin(org2.id, "admin-2");
    const address = `dup-${rand}@itest-b05.example`;
    const barrier = newBarrier(2);
    const la = lane("org1 creates", barrier);
    const lx = lane("org2 creates (upper case)", barrier);
    const logs: UserAdminLogEntry[] = [];
    const input = (email: string) => ({ email, name: "B05 dup", role: UserRole.VIEWER, password: DUMMY_PASSWORD, passwordConfirmation: DUMMY_PASSWORD });
    const outcomes = await Promise.all([
      run(la, () => createUserForAdmin(a, input(address), la.db, options(logs))),
      run(lx, () => createUserForAdmin(x, input(address.toUpperCase()), lx.db, options(logs))),
    ]);
    log(`      ${report(outcomes)}`);
    assert(committedCount(outcomes) === 1, `committed=${committedCount(outcomes)}`);
    const refused = outcomes.find((o) => o.result !== "committed")!;
    assert(refused.result === "USER_ADMIN_EMAIL_EXISTS", `refusal was ${refused.result}`);
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`select count(*) as n from "User" where lower("email") = ${address}`;
    assert(Number(rows[0]!.n) === 1, `users with the address: ${rows[0]!.n}`);
    assert(totalConflicts(outcomes) >= 1, "no serialization conflict observed - the transactions did not overlap");
  });

  log(`\nRESULT: ${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  log(`FAIL  unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await prisma.$disconnect();
  process.exit(1);
});
