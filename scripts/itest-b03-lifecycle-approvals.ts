/**
 * B03 live integration gate - REAL PostgreSQL behavior of approval
 * authority, separation of duties, the legacy hold, the authoritative event
 * order and the append-only lifecycle history (`app/lib/release-db.ts`
 * advanceRevisionForActor + `app/lib/lifecycle-policy-core.ts` + migration
 * 20261105082314_add_item_revision_lifecycle_events).
 *
 * Not part of `npm test`. Talks to the database directly; no dev server.
 *
 * SAFETY (Codex NO-GO finding 2):
 *  1. BEFORE any connection, DATABASE_URL is parsed and refused unless it is
 *     postgres://...@127.0.0.1|localhost:5432/<db> with NO query parameters
 *     that could redirect the connection, <db> equals B03_EXPECTED_DATABASE,
 *     matches ^arch_plm_b03_[a-z0-9_]*scratch[a-z0-9_]*$ and is not a
 *     protected name.
 *  2. AFTER connecting, BEFORE any write: current database, server address,
 *     port and PostgreSQL system identifier (B03_EXPECTED_SYSTEM_ID) must
 *     match; the database may contain only ITEST-B03 organizations; the B03
 *     schema (sequence column, legacy-hold table) and all four append-only
 *     triggers must be present.
 *  3. Every probe of a PROHIBITED operation (UPDATE / DELETE / TRUNCATE of
 *     events or holds, deleting a revision or item that has history,
 *     cross-organization rows) runs inside a transaction that is ALWAYS rolled
 *     back, whatever the probe does. If a prohibited operation unexpectedly
 *     SUCCEEDS, its effect is rolled back and the gate stops immediately
 *     (exit 3) - a missing trigger can never leave a committed change.
 *
 * Normal (permitted) lifecycle operations do commit throwaway ITEST-B03 data;
 * events are append-only, so this gate must only ever run against a
 * disposable scratch database.
 *
 * Run (DATABASE_URL must point at the scratch database):
 *   B03_EXPECTED_DATABASE=<db> B03_EXPECTED_SYSTEM_ID=<id> \
 *     node --experimental-strip-types scripts/itest-b03-lifecycle-approvals.ts
 *
 * Exit codes: 0 all checks passed; 1 a check failed; 2 target not verified
 * (nothing written); 3 STOP - a prohibited transition or operation was
 * allowed (rolled back where it was a probe).
 */
import { randomBytes } from "node:crypto";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import {
  CadDocumentType,
  ItemType,
  LifecycleState,
  UserRole,
} from "../app/generated/prisma/enums.ts";
import {
  LifecyclePermissionError,
  ReleaseBaselineIncompleteError,
  advanceRevisionForActor,
  type ReleaseDb,
} from "../app/lib/release-db.ts";
import type { StorageProvider } from "../app/lib/storage-core.ts";
import { runRollbackOnlyProbe } from "./itest-lib/rollback-probe.ts";

const S = LifecycleState;
const PROTECTED_DATABASES = new Set(["arch_plm", "arch_plm_m3_scratch", "archplm_dev", "postgres", "template0", "template1"]);
const SCRATCH_NAME = /^arch_plm_b03_[a-z0-9_]*scratch[a-z0-9_]*$/;

function log(message: string) {
  console.log(message);
}

// ------------------------------------------------------------
// 1. Pre-connection target check (no PrismaClient exists yet)
// ------------------------------------------------------------

function verifyUrlBeforeConnecting(): void {
  const refuse = (why: string): never => {
    log(`TARGET NOT VERIFIED (before connecting): ${why}`);
    process.exit(2);
  };
  const expectedDb = process.env.B03_EXPECTED_DATABASE ?? "";
  if (!process.env.B03_EXPECTED_SYSTEM_ID) refuse("B03_EXPECTED_SYSTEM_ID is required");
  if (!SCRATCH_NAME.test(expectedDb)) refuse(`B03_EXPECTED_DATABASE '${expectedDb}' is not an arch_plm_b03_*scratch* name`);
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
  if (dbName !== expectedDb) refuse(`URL database '${dbName}' != B03_EXPECTED_DATABASE '${expectedDb}'`);
  for (const key of url.searchParams.keys()) {
    if (!["schema", "connection_limit", "pool_timeout", "connect_timeout", "sslmode"].includes(key)) {
      refuse(`URL query parameter '${key}' is not allowed (could redirect the connection)`);
    }
  }
  log(`URL CHECK: postgres @ ${url.hostname}:${url.port || "5432"}/${dbName} (credentials not shown)`);
}

verifyUrlBeforeConnecting();

const prisma = new PrismaClient();
const db = prisma as unknown as ReleaseDb;

/** Releases in this gate never read file bytes (no versions are frozen). */
const provider = new Proxy({}, {
  get() {
    throw new Error("storage must not be used by this gate");
  },
}) as StorageProvider;

let failed = 0;
let passed = 0;
const notes: string[] = [];

async function stop(reason: string): Promise<never> {
  log(`STOP: ${reason}`);
  await prisma.$disconnect();
  process.exit(3);
}

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
  const [row] = await prisma.$queryRaw<
    { db: string; sysid: string; addr: string | null; port: number; foreignOrgs: bigint }[]
  >`select current_database() as db,
           (select system_identifier::text from pg_control_system()) as sysid,
           host(inet_server_addr()) as addr,
           inet_server_port() as port,
           (select count(*) from "Organization" where code not like 'ITEST-B03-%') as "foreignOrgs"`;
  const ok =
    row &&
    row.db === process.env.B03_EXPECTED_DATABASE &&
    row.sysid === process.env.B03_EXPECTED_SYSTEM_ID &&
    (row.addr === "127.0.0.1" || row.addr === "::1") &&
    Number(row.port) === 5432 &&
    Number(row.foreignOrgs) === 0;
  if (!ok) {
    log(`TARGET NOT VERIFIED (after connecting): ${JSON.stringify({ ...row, foreignOrgs: row ? Number(row.foreignOrgs) : null })}`);
    await prisma.$disconnect();
    process.exit(2);
  }
  const [schema] = await prisma.$queryRaw<{ seq: bigint; hold: bigint; triggers: string | null }[]>`
    select (select count(*) from information_schema.columns
              where table_name = 'ItemRevisionLifecycleEvent' and column_name = 'sequence') as seq,
           (select count(*) from information_schema.tables
              where table_name = 'ItemRevisionLegacyLifecycleHold') as hold,
           (select string_agg(tgname, ',' order by tgname) from pg_trigger
              where not tgisinternal and tgrelid in ('"ItemRevisionLifecycleEvent"'::regclass, '"ItemRevisionLegacyLifecycleHold"'::regclass)) as triggers`;
  const expectedTriggers = [
    "ItemRevisionLegacyLifecycleHold_append_only_row",
    "ItemRevisionLegacyLifecycleHold_append_only_truncate",
    "ItemRevisionLifecycleEvent_append_only_row",
    "ItemRevisionLifecycleEvent_append_only_truncate",
  ].join(",");
  if (Number(schema!.seq) !== 1 || Number(schema!.hold) !== 1 || schema!.triggers !== expectedTriggers) {
    log(`TARGET NOT VERIFIED: B03 schema incomplete (sequence=${schema!.seq}, hold table=${schema!.hold}, triggers=${schema!.triggers})`);
    await prisma.$disconnect();
    process.exit(2);
  }
  log(`TARGET VERIFIED: ${row.db} @ ${row.addr}:${row.port} system_identifier=${row.sysid}; only ITEST-B03 data; B03 schema + 4 append-only triggers present`);
}

// ------------------------------------------------------------
// 3. Rollback-only probe of a PROHIBITED operation
// ------------------------------------------------------------

/**
 * Run `operation` inside a transaction that is ALWAYS rolled back
 * (`scripts/itest-lib/rollback-probe.ts`). Returns the database's refusal
 * message. If the operation SUCCEEDS, its effect has been rolled back and the
 * gate stops immediately.
 */
async function probeMustBeRefused(
  label: string,
  operation: (tx: PrismaClient) => Promise<unknown>,
  expected: RegExp,
): Promise<string> {
  const result = await runRollbackOnlyProbe(prisma, operation);
  if (!result.refused) {
    return stop(`prohibited operation "${label}" SUCCEEDED (its effect was rolled back)`);
  }
  assert(expected.test(result.message), `${label}: refused, but with an unexpected error: ${result.message.slice(0, 300)}`);
  return result.message;
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const rand = randomBytes(4).toString("hex");
type U = { userId: string; organizationId: string; role: UserRole; name: string; email: string };

async function makeOrg(tag: string) {
  return prisma.organization.create({ data: { name: `ITEST B03 ${tag} ${rand}`, code: `ITEST-B03-${tag}-${rand}` } });
}

async function makeUser(organizationId: string, key: string, role: UserRole, active = true): Promise<U> {
  const email = `${key}-${rand}@itest-b03.example`;
  const user = await prisma.user.create({ data: { organizationId, email, name: `B03 ${key}`, role, active } });
  return { userId: user.id, organizationId, role, name: user.name, email };
}

let itemCounter = 0;
async function makeRevision(
  organizationId: string,
  createdById: string | null,
  lifecycle: LifecycleState = S.WORKING,
  extra: { revision?: string; itemId?: string; sourceRevisionId?: string; legacyHold?: boolean } = {},
) {
  let itemId = extra.itemId;
  if (!itemId) {
    itemCounter += 1;
    const item = await prisma.item.create({
      data: { organizationId, itemNumber: `B03-${rand}-${itemCounter}`, description: "B03 itest item", type: ItemType.PART },
    });
    itemId = item.id;
  }
  const rev = await prisma.itemRevision.create({
    data: { organizationId, itemId, revision: extra.revision ?? "A", lifecycle, createdById, sourceRevisionId: extra.sourceRevisionId ?? null },
  });
  if (extra.legacyHold) {
    // Fixture only: simulates the migration's INSERT ... SELECT backfill for a
    // revision that existed before B03. The application never writes holds.
    await prisma.itemRevisionLegacyLifecycleHold.create({
      data: { organizationId, itemRevisionId: rev.id, lifecycleAtHold: lifecycle },
    });
  }
  return rev;
}

const move = (actor: U, revisionId: string, target: LifecycleState, comment?: string) =>
  advanceRevisionForActor(actor, revisionId, target, db, provider, { comment });

async function stateOf(revisionId: string) {
  const rev = await prisma.itemRevision.findUniqueOrThrow({ where: { id: revisionId }, include: { legacyLifecycleHold: true } });
  const events = await prisma.itemRevisionLifecycleEvent.count({ where: { itemRevisionId: revisionId } });
  const baselines = await prisma.releaseBaseline.count({ where: { itemRevisionId: revisionId } });
  return `${rev.lifecycle}|events=${events}|baselines=${baselines}|createdBy=${rev.createdById}|hold=${rev.legacyLifecycleHold !== null}`;
}

/** A transition that MUST be refused. If it succeeds: STOP. */
async function expectRefused(label: string, revisionId: string, code: string, run: () => Promise<unknown>) {
  const before = await stateOf(revisionId);
  let error: unknown = null;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  if (error === null) {
    await stop(`"${label}" was ALLOWED (state ${before} -> ${await stateOf(revisionId)})`);
  }
  const actual = error instanceof LifecyclePermissionError ? error.code : error instanceof Error ? error.message : String(error);
  assert(actual === code || (error instanceof Error && new RegExp(code).test(error.message)), `${label}: expected ${code}, got ${actual}`);
  const after = await stateOf(revisionId);
  assert(after === before, `${label}: state changed on refusal (${before} -> ${after})`);
}

async function eventsOf(revisionId: string) {
  return prisma.itemRevisionLifecycleEvent.findMany({ where: { itemRevisionId: revisionId }, orderBy: { sequence: "asc" } });
}

const path = (events: { fromState: string; toState: string }[]) => events.map((e) => `${e.fromState}>${e.toState}`);

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
  await verifyTargetAfterConnecting();

  const orgA = await makeOrg("A");
  const orgB = await makeOrg("B");
  const creator = await makeUser(orgA.id, "creator", UserRole.DESIGNER);
  const eng = await makeUser(orgA.id, "eng", UserRole.ENGINEER);
  const des2 = await makeUser(orgA.id, "des2", UserRole.DESIGNER);
  const reviewer = await makeUser(orgA.id, "reviewer", UserRole.REVIEWER);
  const viewer = await makeUser(orgA.id, "viewer", UserRole.VIEWER);
  const appr1 = await makeUser(orgA.id, "appr1", UserRole.APPROVER);
  const appr2 = await makeUser(orgA.id, "appr2", UserRole.APPROVER);
  const admin = await makeUser(orgA.id, "admin", UserRole.ADMIN);
  const adminCreator = await makeUser(orgA.id, "admincreator", UserRole.ADMIN);
  const inactiveAppr = await makeUser(orgA.id, "inactive", UserRole.APPROVER, false);
  const apprB = await makeUser(orgB.id, "apprB", UserRole.APPROVER);

  // ---------------- 1. happy path ----------------
  await check("1 full flow: submit -> approve (comment) -> release by the same approver (D-A6); one event per step in sequence order; baseline by releaser", async () => {
    const rev = await makeRevision(orgA.id, creator.userId);
    await move(eng, rev.id, S.IN_REVIEW);
    await move(appr1, rev.id, S.APPROVED, "  approved \u0007 ");
    await move(appr1, rev.id, S.RELEASED);
    const events = await eventsOf(rev.id);
    assert(JSON.stringify(path(events)) === JSON.stringify(["WORKING>IN_REVIEW", "IN_REVIEW>APPROVED", "APPROVED>RELEASED"]), JSON.stringify(path(events)));
    assert(events[0]!.actedById === eng.userId && events[1]!.actedById === appr1.userId && events[2]!.actedById === appr1.userId, "actors");
    assert(events[1]!.comment === "approved", `comment ${JSON.stringify(events[1]!.comment)}`);
    assert(events[0]!.sequence < events[1]!.sequence && events[1]!.sequence < events[2]!.sequence, "sequence strictly increasing");
    const final = await prisma.itemRevision.findUniqueOrThrow({ where: { id: rev.id }, include: { releaseBaseline: true } });
    assert(final.lifecycle === S.RELEASED && final.releaseBaseline?.createdById === appr1.userId, "released by appr1");
    assert(final.releasedAt?.getTime() === events[2]!.occurredAt.getTime(), "releasedAt != release event occurredAt");
  });

  // ---------------- 2. role authorization ----------------
  await check("2 D-A/D-A9: DESIGNER, REVIEWER, VIEWER cannot approve; inactive APPROVER refused; request-time role claim ignored; ENGINEER-level cannot release or undo approval", async () => {
    const rev = await makeRevision(orgA.id, creator.userId);
    await move(eng, rev.id, S.IN_REVIEW);
    await expectRefused("DESIGNER approve", rev.id, "ROLE_NOT_PERMITTED", () => move(des2, rev.id, S.APPROVED));
    await expectRefused("REVIEWER approve", rev.id, "ROLE_NOT_PERMITTED", () => move(reviewer, rev.id, S.APPROVED));
    await expectRefused("VIEWER approve", rev.id, "ROLE_NOT_PERMITTED", () => move(viewer, rev.id, S.APPROVED));
    await expectRefused("inactive APPROVER approve", rev.id, "ACTOR_NOT_ACTIVE", () => move(inactiveAppr, rev.id, S.APPROVED));
    await expectRefused("DESIGNER claiming APPROVER at request time", rev.id, "ROLE_NOT_PERMITTED", () => move({ ...des2, role: UserRole.APPROVER }, rev.id, S.APPROVED));
    await move(appr1, rev.id, S.APPROVED);
    await expectRefused("DESIGNER release", rev.id, "ROLE_NOT_PERMITTED", () => move(des2, rev.id, S.RELEASED));
    await expectRefused("DESIGNER undo approval (D-A5)", rev.id, "ROLE_NOT_PERMITTED", () => move(des2, rev.id, S.WORKING));
  });

  // ---------------- 3. separation of duties ----------------
  await check("3 D-A/D-A1/D-A4: creator (APPROVER and ADMIN) and any past submitter cannot approve or release", async () => {
    const byAppr2 = await makeRevision(orgA.id, appr2.userId);
    await move(eng, byAppr2.id, S.IN_REVIEW);
    await expectRefused("APPROVER creator approves", byAppr2.id, "CREATOR_CANNOT_APPROVE", () => move(appr2, byAppr2.id, S.APPROVED));

    const byAdmin = await makeRevision(orgA.id, adminCreator.userId);
    await move(eng, byAdmin.id, S.IN_REVIEW);
    await expectRefused("ADMIN creator approves (no override)", byAdmin.id, "CREATOR_CANNOT_APPROVE", () => move(adminCreator, byAdmin.id, S.APPROVED));
    await move(appr1, byAdmin.id, S.APPROVED);
    await expectRefused("ADMIN creator releases (no override)", byAdmin.id, "CREATOR_CANNOT_APPROVE", () => move(adminCreator, byAdmin.id, S.RELEASED));

    const rev = await makeRevision(orgA.id, creator.userId);
    await move(appr1, rev.id, S.IN_REVIEW);
    await move(eng, rev.id, S.WORKING);
    await move(eng, rev.id, S.IN_REVIEW);
    await expectRefused("earlier submitter approves (D-A1)", rev.id, "SUBMITTER_CANNOT_APPROVE", () => move(appr1, rev.id, S.APPROVED));
    await move(appr2, rev.id, S.APPROVED);
    await expectRefused("earlier submitter releases (D-A1)", rev.id, "SUBMITTER_CANNOT_APPROVE", () => move(appr1, rev.id, S.RELEASED));
    await move(admin, rev.id, S.RELEASED);
    // submit (appr1), return (eng), resubmit (eng), approve (appr2), release (admin)
    assert((await stateOf(rev.id)).startsWith("RELEASED|events=5|baselines=1"), await stateOf(rev.id));
  });

  // ---------------- 4. legacy hold (NO-GO finding 1) ----------------
  await check("4a finding 1: legacy IN_REVIEW - 3 return/resubmit cycles never lift the hold; APPROVER and ADMIN refused each cycle; history, creator and hold intact", async () => {
    const rev = await makeRevision(orgA.id, creator.userId, S.IN_REVIEW, { legacyHold: true });
    for (const actor of [appr1, admin]) {
      await expectRefused(`${actor.role} approves legacy`, rev.id, "LEGACY_HISTORY_UNVERIFIED", () => move(actor, rev.id, S.APPROVED));
    }
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await move(des2, rev.id, S.WORKING, `revalidation attempt ${cycle}`);
      await move(eng, rev.id, S.IN_REVIEW);
      for (const actor of [appr1, appr2, admin]) {
        await expectRefused(`cycle ${cycle}: ${actor.role} approves legacy`, rev.id, "LEGACY_HISTORY_UNVERIFIED", () => move(actor, rev.id, S.APPROVED));
      }
    }
    assert((await stateOf(rev.id)) === `IN_REVIEW|events=6|baselines=0|createdBy=${creator.userId}|hold=true`, await stateOf(rev.id));
  });

  await check("4b finding 1: legacy APPROVED - ADMIN release refused; undo approval + resubmission still cannot be approved; legacy WORKING and unknown-creator legacy likewise held", async () => {
    const approved = await makeRevision(orgA.id, creator.userId, S.APPROVED, { legacyHold: true });
    await expectRefused("ADMIN releases legacy APPROVED", approved.id, "LEGACY_HISTORY_UNVERIFIED", () => move(admin, approved.id, S.RELEASED));
    await expectRefused("ENGINEER undoes approval", approved.id, "ROLE_NOT_PERMITTED", () => move(eng, approved.id, S.WORKING));
    await move(appr2, approved.id, S.WORKING);
    await move(eng, approved.id, S.IN_REVIEW);
    await expectRefused("APPROVER approves after revalidation attempt", approved.id, "LEGACY_HISTORY_UNVERIFIED", () => move(appr1, approved.id, S.APPROVED));

    for (const creatorId of [creator.userId, null]) {
      const working = await makeRevision(orgA.id, creatorId, S.WORKING, { legacyHold: true });
      await move(eng, working.id, S.IN_REVIEW);
      await expectRefused(`ADMIN approves legacy WORKING (creator=${creatorId ? "known" : "unknown"})`, working.id, "LEGACY_HISTORY_UNVERIFIED", () => move(admin, working.id, S.APPROVED));
    }
  });

  // ---------------- 5. rollback ----------------
  await check("5 rollback: a release that cannot capture its baseline leaves APPROVED, no RELEASED event, no baseline, predecessor NOT superseded; a successful lineage release writes AUTOMATIC_SUPERSESSION after the release in sequence order", async () => {
    const source = await makeRevision(orgA.id, creator.userId);
    await move(eng, source.id, S.IN_REVIEW);
    await move(appr1, source.id, S.APPROVED);
    await move(appr1, source.id, S.RELEASED);
    const successor = await makeRevision(orgA.id, creator.userId, S.WORKING, { itemId: source.itemId, revision: "B", sourceRevisionId: source.id });
    await move(eng, successor.id, S.IN_REVIEW);
    await move(appr1, successor.id, S.APPROVED);
    const doc = await prisma.cadDocument.create({
      data: { organizationId: orgA.id, documentNumber: `B03-${rand}-DOC`, fileName: `b03-${rand}.ipt`, documentType: CadDocumentType.IPT, createdById: creator.userId },
    });
    await prisma.itemRevisionDocument.create({ data: { organizationId: orgA.id, itemRevisionId: successor.id, cadDocumentId: doc.id, createdById: creator.userId } });
    const sourceBefore = await stateOf(source.id);
    const before = await stateOf(successor.id);
    let error: unknown = null;
    try {
      await move(appr1, successor.id, S.RELEASED);
    } catch (e) {
      error = e;
    }
    assert(error instanceof ReleaseBaselineIncompleteError, `expected ReleaseBaselineIncompleteError, got ${String(error)}`);
    assert((await stateOf(successor.id)) === before, `successor changed: ${await stateOf(successor.id)}`);
    assert((await stateOf(source.id)) === sourceBefore, `source changed: ${await stateOf(source.id)}`);

    const ok = await makeRevision(orgA.id, creator.userId, S.WORKING, { itemId: source.itemId, revision: "C", sourceRevisionId: source.id });
    await move(eng, ok.id, S.IN_REVIEW);
    await move(appr2, ok.id, S.APPROVED);
    await move(appr2, ok.id, S.RELEASED);
    const sup = (await eventsOf(source.id)).at(-1)!;
    const rel = (await eventsOf(ok.id)).at(-1)!;
    assert(sup.toState === S.SUPERSEDED && sup.trigger === "AUTOMATIC_SUPERSESSION" && sup.actedById === appr2.userId, `supersession ${JSON.stringify(sup, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
    assert(rel.toState === S.RELEASED && sup.sequence > rel.sequence, "supersession is sequenced after the release");
  });

  // ---------------- 6. append-only enforcement (rollback-only probes) ----------------
  await check("6 D-A8: UPDATE / DELETE / TRUNCATE of events and holds, and deleting a revision or item with history, are refused - every probe rolled back", async () => {
    const event = await prisma.itemRevisionLifecycleEvent.findFirstOrThrow({ where: { organizationId: orgA.id } });
    const hold = await prisma.itemRevisionLegacyLifecycleHold.findFirstOrThrow({ where: { organizationId: orgA.id } });
    const counts = async () => `${await prisma.itemRevisionLifecycleEvent.count()}/${await prisma.itemRevisionLegacyLifecycleHold.count()}/${await prisma.itemRevision.count()}/${await prisma.item.count()}`;
    const before = await counts();
    const appendOnly = /append-only/;
    const fk = /foreign key|Foreign key|P2003|violates|restrict/i;
    await probeMustBeRefused("UPDATE event", (tx) => tx.$executeRawUnsafe(`UPDATE "ItemRevisionLifecycleEvent" SET "comment" = 'tampered' WHERE "id" = $1`, event.id), appendOnly);
    await probeMustBeRefused("DELETE event", (tx) => tx.$executeRawUnsafe(`DELETE FROM "ItemRevisionLifecycleEvent" WHERE "id" = $1`, event.id), appendOnly);
    await probeMustBeRefused("TRUNCATE events", (tx) => tx.$executeRawUnsafe(`TRUNCATE "ItemRevisionLifecycleEvent"`), appendOnly);
    await probeMustBeRefused("Prisma update event", (tx) => tx.itemRevisionLifecycleEvent.update({ where: { id: event.id }, data: { comment: "tampered" } }), appendOnly);
    await probeMustBeRefused("UPDATE hold", (tx) => tx.$executeRawUnsafe(`UPDATE "ItemRevisionLegacyLifecycleHold" SET "lifecycleAtHold" = 'WORKING' WHERE "itemRevisionId" = $1`, hold.itemRevisionId), appendOnly);
    await probeMustBeRefused("DELETE hold (lift a legacy hold)", (tx) => tx.$executeRawUnsafe(`DELETE FROM "ItemRevisionLegacyLifecycleHold" WHERE "itemRevisionId" = $1`, hold.itemRevisionId), appendOnly);
    await probeMustBeRefused("TRUNCATE holds", (tx) => tx.$executeRawUnsafe(`TRUNCATE "ItemRevisionLegacyLifecycleHold"`), appendOnly);
    await probeMustBeRefused("delete revision with history", (tx) => tx.itemRevision.delete({ where: { id: event.itemRevisionId } }), fk);
    const rev = await prisma.itemRevision.findUniqueOrThrow({ where: { id: event.itemRevisionId } });
    await probeMustBeRefused("delete item whose revision has history (cascade)", (tx) => tx.item.delete({ where: { id: rev.itemId } }), fk);
    const after = await prisma.itemRevisionLifecycleEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert(after.comment === event.comment && after.sequence === event.sequence, "event row changed");
    assert((await counts()) === before, `row counts changed: ${before} -> ${await counts()}`);
  });

  // ---------------- 7. organization isolation ----------------
  await check("7 organization isolation: another org's approver gets 'Revision not found'; cross-org event and hold rows refused by composite FKs (rollback-only probes)", async () => {
    const rev = await makeRevision(orgA.id, creator.userId);
    await move(eng, rev.id, S.IN_REVIEW);
    await expectRefused("orgB approver approves orgA revision", rev.id, "Revision not found", () => move(apprB, rev.id, S.APPROVED));
    const fk = /P2003|Foreign key|foreign key|violates/;
    const eventData = (organizationId: string, actedById: string) => ({
      organizationId, itemRevisionId: rev.id, actedById, fromState: S.IN_REVIEW, toState: S.APPROVED, trigger: "MANUAL" as const, actedByRole: UserRole.APPROVER, occurredAt: new Date(),
    });
    await probeMustBeRefused("orgB event for orgA revision", (tx) => tx.itemRevisionLifecycleEvent.create({ data: eventData(orgB.id, apprB.userId) }), fk);
    await probeMustBeRefused("orgA event acted by orgB user", (tx) => tx.itemRevisionLifecycleEvent.create({ data: eventData(orgA.id, apprB.userId) }), fk);
    await probeMustBeRefused("orgB hold on orgA revision", (tx) => tx.itemRevisionLegacyLifecycleHold.create({ data: { organizationId: orgB.id, itemRevisionId: rev.id, lifecycleAtHold: S.IN_REVIEW } }), fk);
    assert((await stateOf(rev.id)) === `IN_REVIEW|events=1|baselines=0|createdBy=${creator.userId}|hold=false`, await stateOf(rev.id));
  });

  // ---------------- 8. simultaneous attempts ----------------
  const losers: Record<string, number> = {};
  const noteLoser = (r: PromiseSettledResult<unknown>) => {
    if (r.status === "rejected") {
      const e = r.reason;
      const key = e instanceof LifecyclePermissionError ? `LifecyclePermissionError:${e.code}` : e instanceof Error ? e.message : String(e);
      losers[key] = (losers[key] ?? 0) + 1;
    }
  };
  const sequenceLatestMatchesState = async (revisionId: string) => {
    const events = await eventsOf(revisionId);
    const current = (await prisma.itemRevision.findUniqueOrThrow({ where: { id: revisionId } })).lifecycle;
    return events.length > 0 && events.at(-1)!.toState === current;
  };
  await check("8a 20 rounds approve vs approve: one winner, one APPROVED event, sequence-latest event = state", async () => {
    for (let i = 0; i < 20; i += 1) {
      const rev = await makeRevision(orgA.id, creator.userId);
      await move(eng, rev.id, S.IN_REVIEW);
      const results = await Promise.allSettled([move(appr1, rev.id, S.APPROVED), move(appr2, rev.id, S.APPROVED)]);
      results.forEach(noteLoser);
      const wins = results.filter((r) => r.status === "fulfilled").length;
      const approvals = (await eventsOf(rev.id)).filter((e) => e.toState === S.APPROVED).length;
      assert(wins === 1 && approvals === 1 && (await sequenceLatestMatchesState(rev.id)), `round ${i}: wins=${wins} approvedEvents=${approvals}`);
    }
  });
  await check("8b 10 rounds approve vs return-to-Working: one winner; sequence-latest event = state", async () => {
    for (let i = 0; i < 10; i += 1) {
      const rev = await makeRevision(orgA.id, creator.userId);
      await move(eng, rev.id, S.IN_REVIEW);
      const results = await Promise.allSettled([move(appr1, rev.id, S.APPROVED), move(des2, rev.id, S.WORKING)]);
      results.forEach(noteLoser);
      const wins = results.filter((r) => r.status === "fulfilled").length;
      assert(wins === 1 && (await eventsOf(rev.id)).length === 2 && (await sequenceLatestMatchesState(rev.id)), `round ${i}: wins=${wins}`);
    }
  });
  await check("8c 10 rounds release vs release: one RELEASED event and one baseline", async () => {
    for (let i = 0; i < 10; i += 1) {
      const rev = await makeRevision(orgA.id, creator.userId);
      await move(eng, rev.id, S.IN_REVIEW);
      await move(appr1, rev.id, S.APPROVED);
      const results = await Promise.allSettled([move(appr1, rev.id, S.RELEASED), move(admin, rev.id, S.RELEASED)]);
      results.forEach(noteLoser);
      const wins = results.filter((r) => r.status === "fulfilled").length;
      const released = (await eventsOf(rev.id)).filter((e) => e.toState === S.RELEASED).length;
      const baselines = await prisma.releaseBaseline.count({ where: { itemRevisionId: rev.id } });
      assert(wins === 1 && released === 1 && baselines === 1, `round ${i}: wins=${wins} releasedEvents=${released} baselines=${baselines}`);
    }
  });
  notes.push(`concurrency losers by error: ${JSON.stringify(losers)}`);

  // ---------------- 9. invariants ----------------
  await check("9 invariants over every orgA revision: sequence-latest event = current state (or no events); no cross-org rows; released => baseline; no held revision ever APPROVED/RELEASED by an event", async () => {
    const revisions = await prisma.itemRevision.findMany({
      where: { organizationId: orgA.id },
      include: { lifecycleEvents: { orderBy: { sequence: "asc" } }, releaseBaseline: true, legacyLifecycleHold: true },
    });
    for (const rev of revisions) {
      if (rev.lifecycleEvents.length > 0) {
        assert(rev.lifecycleEvents.at(-1)!.toState === rev.lifecycle, `${rev.id}: sequence-latest ${rev.lifecycleEvents.at(-1)!.toState} != ${rev.lifecycle}`);
      }
      if (rev.lifecycle === S.RELEASED || rev.lifecycle === S.SUPERSEDED) assert(rev.releaseBaseline, `${rev.id}: released without baseline`);
      if (rev.legacyLifecycleHold) {
        assert(!rev.lifecycleEvents.some((e) => e.toState === S.APPROVED || e.toState === S.RELEASED), `${rev.id}: held revision was approved/released`);
      }
    }
    const [mismatch] = await prisma.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from "ItemRevisionLifecycleEvent" e
      join "ItemRevision" r on r.id = e."itemRevisionId"
      join "User" u on u.id = e."actedById"
      where e."organizationId" <> r."organizationId" or e."organizationId" <> u."organizationId"`;
    assert(Number(mismatch!.n) === 0, `cross-org event rows: ${mismatch!.n}`);
  });

  // ---------------- 10. timestamps (informational) ----------------
  await check("10 timestamps are informational: app-vs-db skew measured; ordering relies on sequence only", async () => {
    const skews: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const t0 = Date.now();
      const [row] = await prisma.$queryRaw<{ t: Date }[]>`select clock_timestamp() as t`;
      const t1 = Date.now();
      skews.push(row!.t.getTime() - (t0 + t1) / 2);
    }
    const [disagree] = await prisma.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from (
        select "itemRevisionId",
               row_number() over (partition by "itemRevisionId" order by "sequence") as by_seq,
               row_number() over (partition by "itemRevisionId" order by "occurredAt", "sequence") as by_time
        from "ItemRevisionLifecycleEvent" where "organizationId" = ${orgA.id}) t
      where by_seq <> by_time`;
    notes.push(
      `clock: app-vs-db max |skew| ${Math.max(...skews.map(Math.abs)).toFixed(1)} ms; events whose time order differs from sequence order (single host): ${Number(disagree!.n)}`,
    );
  });

  log("");
  for (const note of notes) log(`NOTE  ${note}`);
  log(`RESULT ${passed} passed, ${failed} failed`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    log(`FATAL ${error instanceof Error ? error.stack : String(error)}`);
    await prisma.$disconnect();
    process.exit(1);
  });
