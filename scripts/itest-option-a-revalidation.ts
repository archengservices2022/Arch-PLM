/**
 * Option A live integration gate - REAL PostgreSQL behavior of legacy
 * revalidation (`app/lib/legacy-revalidation-db.ts`), the O-2 lineage
 * exclusions and O-4 lineage supersession (`app/lib/release-db.ts`), and the
 * append-only audit link (migration 20261105113307_add_item_revision_legacy_revalidation).
 *
 * Not part of `npm test`. Talks to the database directly; no dev server.
 *
 * SAFETY (same model as scripts/itest-b03-lifecycle-approvals.ts):
 *  1. BEFORE any connection, DATABASE_URL must be postgres on 127.0.0.1 /
 *     localhost:5432, with no redirecting query parameters, naming a database
 *     equal to B03_EXPECTED_DATABASE that matches
 *     ^arch_plm_b03_[a-z0-9_]*scratch[a-z0-9_]*$ and is not protected.
 *  2. AFTER connecting, BEFORE any write: database, server address/port and
 *     PostgreSQL system identifier (B03_EXPECTED_SYSTEM_ID) must match; only
 *     ITEST-B03 organizations may exist; the B03 and Option A schema (tables,
 *     enum value, all six append-only triggers) must be present.
 *  3. Every probe of a PROHIBITED operation runs in a transaction that is
 *     always rolled back (scripts/itest-lib/rollback-probe.ts); an unexpected
 *     success stops the gate (exit 3) with nothing committed.
 *
 * Permitted operations commit throwaway ITEST-B03-OA data; history and audit
 * rows are append-only, so run only against a disposable scratch database.
 *
 * Exit codes: 0 pass; 1 a check failed; 2 target not verified (nothing
 * written); 3 STOP - a prohibited transition or operation was allowed.
 */
import { randomBytes } from "node:crypto";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { CadDocumentType, ItemType, LifecycleState, UserRole } from "../app/generated/prisma/enums.ts";
import {
  LifecyclePermissionError,
  ReleaseBaselineIncompleteError,
  advanceRevisionForActor,
  type ReleaseDb,
} from "../app/lib/release-db.ts";
import {
  LegacyRevalidationError,
  revalidateLegacyRevisionForActor,
  type LegacyRevalidationDb,
} from "../app/lib/legacy-revalidation-db.ts";
import type { StorageProvider } from "../app/lib/storage-core.ts";
import { runRollbackOnlyProbe } from "./itest-lib/rollback-probe.ts";

const S = LifecycleState;
const PROTECTED = new Set(["arch_plm", "arch_plm_m3_scratch", "archplm_dev", "postgres", "template0", "template1"]);
const SCRATCH_NAME = /^arch_plm_b03_[a-z0-9_]*scratch[a-z0-9_]*$/;
const log = (m: string) => console.log(m);

function verifyUrlBeforeConnecting(): void {
  const refuse = (why: string): never => {
    log(`TARGET NOT VERIFIED (before connecting): ${why}`);
    process.exit(2);
  };
  const expected = process.env.B03_EXPECTED_DATABASE ?? "";
  if (!process.env.B03_EXPECTED_SYSTEM_ID) refuse("B03_EXPECTED_SYSTEM_ID is required");
  if (!SCRATCH_NAME.test(expected) || PROTECTED.has(expected)) refuse(`'${expected}' is not an allowed scratch database`);
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    return refuse("DATABASE_URL is missing or invalid");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") refuse(`protocol ${url.protocol}`);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") refuse(`host ${url.hostname} is not loopback`);
  if ((url.port || "5432") !== "5432") refuse(`port ${url.port}`);
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (db !== expected) refuse(`URL database '${db}' != '${expected}'`);
  for (const key of url.searchParams.keys()) {
    if (!["schema", "connection_limit", "pool_timeout", "connect_timeout", "sslmode"].includes(key)) refuse(`query parameter '${key}' not allowed`);
  }
  log(`URL CHECK: postgres @ ${url.hostname}:${url.port || "5432"}/${db} (credentials not shown)`);
}
verifyUrlBeforeConnecting();

const prisma = new PrismaClient();
const releaseDb = prisma as unknown as ReleaseDb;
const revalDb = prisma as unknown as LegacyRevalidationDb;
const provider = new Proxy({}, { get() { throw new Error("storage must not be used by this gate"); } }) as StorageProvider;

let passed = 0;
let failed = 0;
const notes: string[] = [];
async function stop(reason: string): Promise<never> {
  log(`STOP: ${reason}`);
  await prisma.$disconnect();
  process.exit(3);
}
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; log(`PASS  ${name}`); }
  catch (e) { failed += 1; log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

async function verifyTargetAfterConnecting() {
  const [row] = await prisma.$queryRaw<{ db: string; sysid: string; addr: string | null; port: number; foreign_orgs: bigint }[]>`
    select current_database() as db, (select system_identifier::text from pg_control_system()) as sysid,
           host(inet_server_addr()) as addr, inet_server_port() as port,
           (select count(*) from "Organization" where code not like 'ITEST-B03-%') as foreign_orgs`;
  if (!row || row.db !== process.env.B03_EXPECTED_DATABASE || row.sysid !== process.env.B03_EXPECTED_SYSTEM_ID ||
      (row.addr !== "127.0.0.1" && row.addr !== "::1") || Number(row.port) !== 5432 || Number(row.foreign_orgs) !== 0) {
    log(`TARGET NOT VERIFIED (after connecting): ${JSON.stringify({ ...row, foreign_orgs: row ? Number(row.foreign_orgs) : null })}`);
    await prisma.$disconnect();
    process.exit(2);
  }
  const [schema] = await prisma.$queryRaw<{ enumv: bigint; tables: bigint; triggers: bigint }[]>`
    select (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'LifecycleEventTrigger' and e.enumlabel = 'LEGACY_REVALIDATION') as enumv,
           (select count(*) from information_schema.tables where table_name in ('ItemRevisionLifecycleEvent','ItemRevisionLegacyLifecycleHold','ItemRevisionLegacyRevalidation')) as tables,
           (select count(*) from pg_trigger where not tgisinternal and tgname like 'ItemRevision%append_only%') as triggers`;
  if (Number(schema!.enumv) !== 1 || Number(schema!.tables) !== 3 || Number(schema!.triggers) !== 6) {
    log(`TARGET NOT VERIFIED: B03 + Option A schema incomplete (enum=${schema!.enumv} tables=${schema!.tables} triggers=${schema!.triggers})`);
    await prisma.$disconnect();
    process.exit(2);
  }
  log(`TARGET VERIFIED: ${row.db} @ ${row.addr}:${row.port} system_identifier=${row.sysid}; only ITEST-B03 data; B03 + Option A schema with 6 append-only triggers`);
}

async function probeMustBeRefused(label: string, op: (tx: PrismaClient) => Promise<unknown>, expected: RegExp) {
  const r = await runRollbackOnlyProbe(prisma, op);
  if (!r.refused) return stop(`prohibited operation "${label}" SUCCEEDED (rolled back)`);
  assert(expected.test(r.message), `${label}: unexpected error ${r.message.slice(0, 300)}`);
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------
const rand = randomBytes(4).toString("hex");
type U = { userId: string; organizationId: string; role: UserRole; name: string; email: string };
async function makeOrg(tag: string) {
  return prisma.organization.create({ data: { name: `ITEST B03 ${tag} ${rand}`, code: `ITEST-B03-${tag}-${rand}` } });
}
async function makeUser(orgId: string, key: string, role: UserRole, active = true): Promise<U> {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${key}-${rand}@itest-oa.example`, name: `OA ${key}`, role, active } });
  return { userId: u.id, organizationId: orgId, role, name: u.name, email: u.email };
}
let itemN = 0;
async function makeItem(orgId: string) {
  itemN += 1;
  return prisma.item.create({ data: { organizationId: orgId, itemNumber: `OA-${rand}-${itemN}`, description: "OA item", type: ItemType.PART } });
}
/** A pre-B03 ("legacy") revision: created directly with a hold row, exactly as the B03 migration's backfill would leave it. */
async function makeLegacy(orgId: string, itemId: string, revision: string, lifecycle: LifecycleState, createdById: string | null, extra: { sourceRevisionId?: string; releasedAt?: Date } = {}) {
  const rev = await prisma.itemRevision.create({ data: { organizationId: orgId, itemId, revision, lifecycle, createdById, description: `legacy ${revision}`, sourceRevisionId: extra.sourceRevisionId ?? null, releasedAt: extra.releasedAt ?? null } });
  await prisma.itemRevisionLegacyLifecycleHold.create({ data: { organizationId: orgId, itemRevisionId: rev.id, lifecycleAtHold: lifecycle } });
  return rev;
}
async function makeDoc(orgId: string, createdById: string, n: string) {
  return prisma.cadDocument.create({ data: { organizationId: orgId, documentNumber: `OA-${rand}-${n}`, fileName: `oa-${rand}-${n}.ipt`, documentType: CadDocumentType.IPT, createdById } });
}
const REASON = "Pre-B03 work; re-review under B03";
const reval = (a: U, id: string, opts: Partial<{ carryForward: string; selected: string[]; description: string; comment: unknown }> = {}) =>
  revalidateLegacyRevisionForActor(a, id, { carryForward: opts.carryForward ?? "all", selectedCadDocumentIds: opts.selected ?? [], description: opts.description ?? null, comment: "comment" in opts ? opts.comment : REASON }, revalDb);
const move = (a: U, id: string, to: LifecycleState) => advanceRevisionForActor(a, id, to, releaseDb, provider);

async function stateOf(id: string) {
  const r = await prisma.itemRevision.findUniqueOrThrow({ where: { id }, include: { legacyLifecycleHold: true } });
  const ev = await prisma.itemRevisionLifecycleEvent.count({ where: { itemRevisionId: id } });
  const succ = await prisma.itemRevision.count({ where: { sourceRevisionId: id } });
  const audit = await prisma.itemRevisionLegacyRevalidation.count({ where: { OR: [{ legacyRevisionId: id }, { successorRevisionId: id }] } });
  return `${r.lifecycle}|creator=${r.createdById}|hold=${r.legacyLifecycleHold ? "yes" : "no"}|events=${ev}|successors=${succ}|audit=${audit}`;
}
async function expectRefused(label: string, id: string, code: string, run: () => Promise<unknown>) {
  const before = await stateOf(id);
  let err: unknown = null;
  try { await run(); } catch (e) { err = e; }
  if (err === null) return stop(`"${label}" was ALLOWED (${before} -> ${await stateOf(id)})`);
  const actual = err instanceof LegacyRevalidationError || err instanceof LifecyclePermissionError ? err.code : err instanceof Error ? err.message : String(err);
  assert(actual === code || new RegExp(code).test(actual), `${label}: expected ${code}, got ${actual}`);
  assert((await stateOf(id)) === before, `${label}: state changed on refusal`);
}

async function main() {
  await verifyTargetAfterConnecting();
  const orgA = await makeOrg("OA");
  const orgB = await makeOrg("OB");
  const creator = await makeUser(orgA.id, "creator", UserRole.DESIGNER);
  const eng = await makeUser(orgA.id, "eng", UserRole.ENGINEER);
  const des2 = await makeUser(orgA.id, "des2", UserRole.DESIGNER);
  const reviewer = await makeUser(orgA.id, "reviewer", UserRole.REVIEWER);
  const viewer = await makeUser(orgA.id, "viewer", UserRole.VIEWER);
  const appr1 = await makeUser(orgA.id, "appr1", UserRole.APPROVER);
  const appr2 = await makeUser(orgA.id, "appr2", UserRole.APPROVER);
  const admin = await makeUser(orgA.id, "admin", UserRole.ADMIN);
  const legacySub = await makeUser(orgA.id, "legacysub", UserRole.ADMIN);
  const inactive = await makeUser(orgA.id, "inactive", UserRole.APPROVER, false);
  const apprB = await makeUser(orgB.id, "apprB", UserRole.APPROVER);

  // ---------- 1. revalidation per legacy state ----------
  for (const [state, path] of [
    [S.WORKING, "WORKING>OBSOLETE"],
    [S.IN_REVIEW, "IN_REVIEW>WORKING,WORKING>OBSOLETE"],
    [S.APPROVED, "APPROVED>WORKING,WORKING>OBSOLETE"],
  ] as const) {
    await check(`1 revalidate held ${state}: closure via existing transitions, successor (trusted creator, lineage, WORKING, no hold, highest+1), shared document links, one audit row; legacy hold/creator/baselines intact`, async () => {
      const item = await makeItem(orgA.id);
      const b = await makeLegacy(orgA.id, item.id, "B", S.RELEASED, creator.userId, { releasedAt: new Date("2026-01-01T00:00:00Z") });
      await prisma.releaseBaseline.create({ data: { organizationId: orgA.id, itemRevisionId: b.id, createdById: creator.userId } });
      const legacy = await makeLegacy(orgA.id, item.id, "C", state, creator.userId, { sourceRevisionId: b.id });
      const d1 = await makeDoc(orgA.id, creator.userId, `${state}-1`);
      const d2 = await makeDoc(orgA.id, creator.userId, `${state}-2`);
      for (const d of [d1, d2]) await prisma.itemRevisionDocument.create({ data: { organizationId: orgA.id, itemRevisionId: legacy.id, cadDocumentId: d.id, createdById: creator.userId } });
      const docsBefore = await prisma.cadDocument.count({ where: { organizationId: orgA.id } });
      const actorFor = state === S.APPROVED ? appr1 : eng;
      const r = await reval(actorFor, legacy.id, { comment: `  ${REASON} \u0007` });
      assert(r.status === "REVALIDATED" && r.successorRevision === "D", JSON.stringify(r));
      const events = await prisma.itemRevisionLifecycleEvent.findMany({ where: { itemRevisionId: legacy.id }, orderBy: { sequence: "asc" } });
      assert(events.map((e) => `${e.fromState}>${e.toState}`).join(",") === path, events.map((e) => `${e.fromState}>${e.toState}`).join(","));
      assert(events.every((e) => e.trigger === "LEGACY_REVALIDATION" && e.comment === REASON && e.actedById === actorFor.userId), "closure event fields");
      const succ = await prisma.itemRevision.findUniqueOrThrow({ where: { id: r.successorRevisionId }, include: { legacyLifecycleHold: true, documentLinks: true } });
      assert(succ.lifecycle === S.WORKING && succ.createdById === actorFor.userId && succ.sourceRevisionId === legacy.id && !succ.legacyLifecycleHold && succ.itemId === item.id && succ.description === "legacy C", "successor fields");
      assert(succ.documentLinks.map((l) => l.cadDocumentId).sort().join() === [d1.id, d2.id].sort().join(), "links");
      assert((await prisma.cadDocument.count({ where: { organizationId: orgA.id } })) === docsBefore, "no CadDocument copied");
      const audit = await prisma.itemRevisionLegacyRevalidation.findUniqueOrThrow({ where: { legacyRevisionId: legacy.id } });
      assert(audit.successorRevisionId === succ.id && audit.actedById === actorFor.userId && audit.actedByRole === actorFor.role && audit.comment === REASON, "audit row");
      const after = await prisma.itemRevision.findUniqueOrThrow({ where: { id: legacy.id }, include: { legacyLifecycleHold: true, documentLinks: true } });
      assert(after.lifecycle === S.OBSOLETE && after.legacyLifecycleHold?.lifecycleAtHold === state && after.createdById === creator.userId && after.revision === "C" && after.documentLinks.length === 2, "legacy preserved");
      assert((await prisma.itemRevision.findUniqueOrThrow({ where: { id: b.id } })).lifecycle === S.RELEASED && (await prisma.releaseBaseline.count({ where: { itemRevisionId: b.id } })) === 1, "older release + baseline untouched");
    });
  }

  // ---------- 2. roles, eligibility, reason ----------
  await check("2 O-3/O-5 refusals write nothing: VIEWER, inactive, ENGINEER/DESIGNER/REVIEWER on APPROVED, role claim ignored, no hold, terminal, blank reason; write roles allowed on WORKING/IN_REVIEW", async () => {
    const item = await makeItem(orgA.id);
    const w = await makeLegacy(orgA.id, item.id, "A", S.WORKING, creator.userId);
    const ap = await makeLegacy(orgA.id, item.id, "B", S.APPROVED, creator.userId);
    const rel = await makeLegacy(orgA.id, item.id, "C", S.RELEASED, creator.userId);
    const plain = await prisma.itemRevision.create({ data: { organizationId: orgA.id, itemId: item.id, revision: "D", createdById: creator.userId } });
    await expectRefused("VIEWER", w.id, "ROLE_NOT_PERMITTED", () => reval(viewer, w.id));
    await expectRefused("inactive APPROVER", ap.id, "ACTOR_NOT_ACTIVE", () => reval(inactive, ap.id));
    for (const a of [eng, des2, reviewer]) await expectRefused(`${a.role} on APPROVED`, ap.id, "ROLE_NOT_PERMITTED", () => reval(a, ap.id));
    await expectRefused("DESIGNER claiming APPROVER", ap.id, "ROLE_NOT_PERMITTED", () => reval({ ...des2, role: UserRole.APPROVER }, ap.id));
    await expectRefused("no hold", plain.id, "NOT_LEGACY", () => reval(eng, plain.id));
    await expectRefused("RELEASED legacy", rel.id, "NOT_ELIGIBLE_STATE", () => reval(admin, rel.id));
    for (const blank of [undefined, "", "   "]) await expectRefused(`blank reason ${JSON.stringify(blank)}`, w.id, "REASON_REQUIRED", () => reval(eng, w.id, { comment: blank }));
    for (const a of [des2, reviewer]) {
      const item2 = await makeItem(orgA.id);
      const l = await makeLegacy(orgA.id, item2.id, "A", S.IN_REVIEW, creator.userId);
      assert((await reval(a, l.id)).status === "REVALIDATED", `${a.role} on IN_REVIEW`);
    }
  });

  // ---------- 3. letters ----------
  await check("3 successor letter = highest existing + 1 (gaps not filled); Z exhaustion refused before any write", async () => {
    const item = await makeItem(orgA.id);
    const l = await makeLegacy(orgA.id, item.id, "A", S.WORKING, creator.userId);
    await makeLegacy(orgA.id, item.id, "F", S.RELEASED, creator.userId);
    assert((await reval(eng, l.id)).successorRevision === "G", "highest+1");
    const itemZ = await makeItem(orgA.id);
    const y = await makeLegacy(orgA.id, itemZ.id, "Y", S.IN_REVIEW, creator.userId);
    await makeLegacy(orgA.id, itemZ.id, "Z", S.RELEASED, creator.userId);
    await expectRefused("Z exhausted", y.id, "REVISION_LIMIT", () => reval(eng, y.id));
  });

  // ---------- 4. duplicates and concurrency ----------
  await check("4a sequential duplicate returns ALREADY_REVALIDATED with the same successor; nothing written", async () => {
    const item = await makeItem(orgA.id);
    const l = await makeLegacy(orgA.id, item.id, "A", S.IN_REVIEW, creator.userId);
    const first = await reval(eng, l.id);
    const before = await stateOf(l.id);
    const second = await reval(des2, l.id, { comment: "again" });
    assert(second.status === "ALREADY_REVALIDATED" && second.successorRevisionId === first.successorRevisionId, JSON.stringify(second));
    assert((await stateOf(l.id)) === before, "changed");
  });
  const outcomes: Record<string, number> = {};
  const note = (r: PromiseSettledResult<{ status: string }>) => {
    const k = r.status === "fulfilled" ? r.value.status : r.reason instanceof LegacyRevalidationError ? `refused:${r.reason.code}` : `error:${String(r.reason).slice(0, 80)}`;
    outcomes[k] = (outcomes[k] ?? 0) + 1;
  };
  await check("4b 15 rounds of two concurrent revalidations of the SAME legacy revision: exactly one successor and one audit row; legacy OBSOLETE; loser reports the existing successor or a clean refusal", async () => {
    for (let i = 0; i < 15; i += 1) {
      const item = await makeItem(orgA.id);
      const l = await makeLegacy(orgA.id, item.id, "A", i % 3 === 0 ? S.WORKING : i % 3 === 1 ? S.IN_REVIEW : S.APPROVED, creator.userId);
      const [x, y] = i % 3 === 2 ? [appr1, admin] : [eng, des2];
      const results = await Promise.allSettled([reval(x, l.id), reval(y, l.id)]);
      results.forEach(note);
      const succ = await prisma.itemRevision.count({ where: { sourceRevisionId: l.id } });
      const audit = await prisma.itemRevisionLegacyRevalidation.count({ where: { legacyRevisionId: l.id } });
      const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === "REVALIDATED").length;
      assert(succ === 1 && audit === 1 && ok === 1 && (await prisma.itemRevision.findUniqueOrThrow({ where: { id: l.id } })).lifecycle === S.OBSOLETE, `round ${i}: successors=${succ} audit=${audit} revalidated=${ok}`);
      for (const r of results) if (r.status === "rejected") assert(r.reason instanceof LegacyRevalidationError && ["CONCURRENT_CHANGE", "REVISION_COLLISION"].includes(r.reason.code), `round ${i}: ${String(r.reason)}`);
    }
  });
  await check("4c 10 rounds: two DIFFERENT held revisions of the same item revalidated concurrently - letters never duplicate; each legacy is closed iff it has exactly one successor", async () => {
    for (let i = 0; i < 10; i += 1) {
      const item = await makeItem(orgA.id);
      const l1 = await makeLegacy(orgA.id, item.id, "A", S.WORKING, creator.userId);
      const l2 = await makeLegacy(orgA.id, item.id, "B", S.IN_REVIEW, creator.userId);
      const results = await Promise.allSettled([reval(eng, l1.id), reval(des2, l2.id)]);
      results.forEach(note);
      const letters = (await prisma.itemRevision.findMany({ where: { itemId: item.id }, select: { revision: true } })).map((r) => r.revision);
      assert(new Set(letters).size === letters.length, `round ${i}: duplicate letter ${letters}`);
      for (const l of [l1, l2]) {
        const closed = (await prisma.itemRevision.findUniqueOrThrow({ where: { id: l.id } })).lifecycle === S.OBSOLETE;
        const n = await prisma.itemRevisionLegacyRevalidation.count({ where: { legacyRevisionId: l.id } });
        assert(closed === (n === 1), `round ${i}: closed=${closed} audit=${n}`);
      }
    }
  });

  // ---------- 5. O-2 on real rows ----------
  await check("5 O-2: legacy creator, a recorded legacy submitter and the revalidating person are refused approve and release of the successor; a non-excluded approver may", async () => {
    const item = await makeItem(orgA.id);
    const legacy = await makeLegacy(orgA.id, item.id, "A", S.WORKING, appr2.userId); // legacy creator is an APPROVER
    await move(legacySub, legacy.id, S.IN_REVIEW); // recorded legacy submitter (allowed: not an approval)
    const r = await reval(appr1, legacy.id); // revalidator = appr1 (also successor creator)
    await move(eng, r.successorRevisionId, S.IN_REVIEW);
    await expectRefused("legacy creator approves successor", r.successorRevisionId, "LEGACY_LINEAGE_EXCLUDED", () => move(appr2, r.successorRevisionId, S.APPROVED));
    await expectRefused("legacy submitter approves successor", r.successorRevisionId, "LEGACY_LINEAGE_EXCLUDED", () => move(legacySub, r.successorRevisionId, S.APPROVED));
    await expectRefused("revalidator approves successor", r.successorRevisionId, "CREATOR_CANNOT_APPROVE", () => move(appr1, r.successorRevisionId, S.APPROVED));
    await move(admin, r.successorRevisionId, S.APPROVED);
    await expectRefused("legacy creator releases successor", r.successorRevisionId, "LEGACY_LINEAGE_EXCLUDED", () => move(appr2, r.successorRevisionId, S.RELEASED));
    await expectRefused("legacy submitter releases successor", r.successorRevisionId, "LEGACY_LINEAGE_EXCLUDED", () => move(legacySub, r.successorRevisionId, S.RELEASED));
    await move(admin, r.successorRevisionId, S.RELEASED);
  });

  // ---------- 6. O-4 on real rows ----------
  await check("6 O-4: releasing the successor supersedes the legacy revision's RELEASED source (event, sequenced after the release); a failed release supersedes nothing", async () => {
    const item = await makeItem(orgA.id);
    const b = await makeLegacy(orgA.id, item.id, "B", S.RELEASED, creator.userId, { releasedAt: new Date("2026-01-01T00:00:00Z") });
    const legacy = await makeLegacy(orgA.id, item.id, "C", S.APPROVED, creator.userId, { sourceRevisionId: b.id });
    const r = await reval(appr1, legacy.id, { carryForward: "none" });
    await move(eng, r.successorRevisionId, S.IN_REVIEW);
    await move(admin, r.successorRevisionId, S.APPROVED);
    // Failed release first: a linked document with no file version.
    const doc = await makeDoc(orgA.id, creator.userId, "broken");
    await prisma.itemRevisionDocument.create({ data: { organizationId: orgA.id, itemRevisionId: r.successorRevisionId, cadDocumentId: doc.id, createdById: creator.userId } });
    const bBefore = await stateOf(b.id);
    let err: unknown = null;
    try { await move(admin, r.successorRevisionId, S.RELEASED); } catch (e) { err = e; }
    assert(err instanceof ReleaseBaselineIncompleteError, `expected ReleaseBaselineIncompleteError, got ${String(err)}`);
    assert((await stateOf(b.id)) === bBefore, "B changed after a failed release");
    // Remove the broken link (permitted) and release for real.
    await prisma.itemRevisionDocument.deleteMany({ where: { itemRevisionId: r.successorRevisionId } });
    await move(admin, r.successorRevisionId, S.RELEASED);
    const bAfter = await prisma.itemRevision.findUniqueOrThrow({ where: { id: b.id } });
    const sup = (await prisma.itemRevisionLifecycleEvent.findMany({ where: { itemRevisionId: b.id }, orderBy: { sequence: "asc" } })).at(-1)!;
    const rel = (await prisma.itemRevisionLifecycleEvent.findMany({ where: { itemRevisionId: r.successorRevisionId }, orderBy: { sequence: "asc" } })).at(-1)!;
    assert(bAfter.lifecycle === S.SUPERSEDED && sup.trigger === "AUTOMATIC_SUPERSESSION" && sup.actedById === admin.userId && sup.sequence > rel.sequence && rel.toState === S.RELEASED, "lineage supersession");
    assert((await prisma.itemRevision.findUniqueOrThrow({ where: { id: legacy.id } })).lifecycle === S.OBSOLETE, "legacy stays OBSOLETE");
  });

  // ---------- 7. append-only + FK protections (rollback-only probes) ----------
  await check("7 audit table: UPDATE / DELETE / TRUNCATE refused; deleting a legacy or successor revision with an audit link refused; counts unchanged", async () => {
    const audit = await prisma.itemRevisionLegacyRevalidation.findFirstOrThrow({ where: { organizationId: orgA.id } });
    const before = `${await prisma.itemRevisionLegacyRevalidation.count()}/${await prisma.itemRevision.count()}`;
    const appendOnly = /append-only/;
    const fk = /foreign key|Foreign key|P2003|violates|restrict/i;
    await probeMustBeRefused("UPDATE audit", (tx) => tx.$executeRawUnsafe(`UPDATE "ItemRevisionLegacyRevalidation" SET "comment" = 'x' WHERE "id" = $1`, audit.id), appendOnly);
    await probeMustBeRefused("DELETE audit", (tx) => tx.$executeRawUnsafe(`DELETE FROM "ItemRevisionLegacyRevalidation" WHERE "id" = $1`, audit.id), appendOnly);
    await probeMustBeRefused("TRUNCATE audit", (tx) => tx.$executeRawUnsafe(`TRUNCATE "ItemRevisionLegacyRevalidation"`), appendOnly);
    await probeMustBeRefused("Prisma update audit", (tx) => tx.itemRevisionLegacyRevalidation.update({ where: { id: audit.id }, data: { comment: "x" } }), appendOnly);
    await probeMustBeRefused("delete successor revision", (tx) => tx.itemRevision.delete({ where: { id: audit.successorRevisionId } }), fk);
    await probeMustBeRefused("delete legacy revision", (tx) => tx.itemRevision.delete({ where: { id: audit.legacyRevisionId } }), fk);
    assert(`${await prisma.itemRevisionLegacyRevalidation.count()}/${await prisma.itemRevision.count()}` === before, "counts changed");
  });

  // ---------- 8. organization isolation ----------
  await check("8 organization isolation: another org's approver gets NOT_FOUND; cross-org audit rows refused by composite FKs (rollback-only)", async () => {
    const item = await makeItem(orgA.id);
    const l = await makeLegacy(orgA.id, item.id, "A", S.WORKING, creator.userId);
    await expectRefused("orgB revalidates orgA legacy", l.id, "NOT_FOUND", () => reval(apprB, l.id));
    const succ = await prisma.itemRevision.create({ data: { organizationId: orgA.id, itemId: item.id, revision: "B", createdById: eng.userId } });
    const fk = /P2003|Foreign key|foreign key|violates/;
    const row = (organizationId: string, actedById: string) => ({ organizationId, legacyRevisionId: l.id, successorRevisionId: succ.id, actedById, actedByRole: UserRole.APPROVER, comment: "x", occurredAt: new Date() });
    await probeMustBeRefused("orgB audit row for orgA revisions", (tx) => tx.itemRevisionLegacyRevalidation.create({ data: row(orgB.id, apprB.userId) }), fk);
    await probeMustBeRefused("orgA audit row acted by orgB user", (tx) => tx.itemRevisionLegacyRevalidation.create({ data: row(orgA.id, apprB.userId) }), fk);
  });

  // ---------- 9. migrated legacy data ----------
  await check("9 a hold written by the B03 MIGRATION (seed org) is revalidated; its successor goes through normal B03 review by a non-excluded approver", async () => {
    // REQUIRED fixture (Codex LOW finding): this check must never pass
    // without executing. Missing seed data is a FAILURE, not a skip.
    // Prefer an IN_REVIEW seed revision; APPROVED / WORKING seed revisions carry
    // equally migration-created holds and keep the check runnable on reruns.
    const candidates = await prisma.itemRevision.findMany({
      where: { lifecycle: { in: [S.IN_REVIEW, S.APPROVED, S.WORKING] }, legacyLifecycleHold: { isNot: null }, legacyRevalidationAsLegacy: { is: null }, organization: { code: { startsWith: "ITEST-B03-SEED" } }, createdById: { not: null } },
      include: { organization: true, legacyLifecycleHold: true },
    });
    const preference: LifecycleState[] = [S.IN_REVIEW, S.APPROVED, S.WORKING];
    const rank = (l: LifecycleState) => preference.indexOf(l);
    const seeded = candidates.sort((a, b) => rank(a.lifecycle) - rank(b.lifecycle) || a.id.localeCompare(b.id))[0];
    assert(seeded && seeded.legacyLifecycleHold, "required fixture missing: no unrevalidated IN_REVIEW/APPROVED/WORKING revision with a migration-created hold in an ITEST-B03-SEED organization (re-seed a fresh scratch database)");
    // Prove the hold was written by the B03 migration's backfill, not by a
    // test fixture, without comparing timestamps across clock bases: the
    // backfill writes every hold in ONE statement, so all backfilled holds
    // share one exact recordedAt; fixture holds are inserted one by one.
    const [backfill] = await prisma.$queryRaw<{ recorded_at: Date; holds: bigint }[]>`
      select "recordedAt" as recorded_at, count(*) as holds from "ItemRevisionLegacyLifecycleHold"
       group by "recordedAt" order by count(*) desc limit 1`;
    assert(backfill && Number(backfill.holds) >= 27, `required fixture missing: no backfill group of at least 27 holds (largest group ${backfill ? Number(backfill.holds) : 0})`);
    assert(seeded.legacyLifecycleHold.recordedAt.getTime() === backfill.recorded_at.getTime(), "hold was not written by the B03 migration backfill");
    assert(seeded.legacyLifecycleHold.lifecycleAtHold === seeded.lifecycle, "migrated hold does not record the revision's state");
    const users = await prisma.user.findMany({ where: { organizationId: seeded.organizationId } });
    const pick = (prefix: string) => {
      const u = users.find((x) => x.email.startsWith(`${prefix}-`));
      assert(u, `required fixture missing: seeded user '${prefix}' in ${seeded.organization.code}`);
      return { userId: u.id, organizationId: u.organizationId, role: u.role, name: u.name, email: u.email };
    };
    // The revalidator is the seeded ADMIN (an approval-capable role), so the
    // refusal below must come from the creator rule, not the role rule.
    const [sEng, sAppr, sAdmin] = [pick("eng"), pick("appr"), pick("admin")];
    const r = await reval(sAdmin, seeded.id);
    assert(r.status === "REVALIDATED", JSON.stringify(r));
    await move(sEng, r.successorRevisionId, S.IN_REVIEW);
    await expectRefused("revalidating ADMIN approves own successor", r.successorRevisionId, "CREATOR_CANNOT_APPROVE", () => move(sAdmin, r.successorRevisionId, S.APPROVED));
    await move(sAppr, r.successorRevisionId, S.APPROVED);
    const hold = await prisma.itemRevisionLegacyLifecycleHold.findUniqueOrThrow({ where: { itemRevisionId: seeded.id } });
    assert(hold.lifecycleAtHold === seeded.lifecycle && hold.recordedAt.getTime() === seeded.legacyLifecycleHold.recordedAt.getTime(), "migrated hold unchanged");
    notes.push(`check 9 EXECUTED on migration-created hold: ${seeded.lifecycle} revision ${seeded.id} (${seeded.organization.code}); hold is in the backfill group of ${Number(backfill.holds)} holds sharing one recordedAt; successor ${r.successorRevision} approved by a non-excluded approver`);
  });

  // ---------- 10. B03 protections still intact ----------
  await check("10 B03 intact: a held legacy revision still cannot be approved directly (APPROVER/ADMIN), even after return/resubmit", async () => {
    const item = await makeItem(orgA.id);
    const l = await makeLegacy(orgA.id, item.id, "A", S.IN_REVIEW, creator.userId);
    await expectRefused("ADMIN approves held legacy", l.id, "LEGACY_HISTORY_UNVERIFIED", () => move(admin, l.id, S.APPROVED));
    await move(eng, l.id, S.WORKING);
    await move(eng, l.id, S.IN_REVIEW);
    await expectRefused("APPROVER approves held legacy after resubmit", l.id, "LEGACY_HISTORY_UNVERIFIED", () => move(appr1, l.id, S.APPROVED));
  });

  // ---------- 11. invariants ----------
  await check("11 invariants over every revalidation row: legacy OBSOLETE and still held; successor sources the legacy, has no hold, was created by the revalidator, same item; no cross-org rows", async () => {
    const rows = await prisma.itemRevisionLegacyRevalidation.findMany({ include: { legacyRevision: { include: { legacyLifecycleHold: true } }, successorRevision: { include: { legacyLifecycleHold: true } } } });
    for (const r of rows) {
      assert(r.legacyRevision.lifecycle === S.OBSOLETE && r.legacyRevision.legacyLifecycleHold, `${r.id}: legacy`);
      assert(r.successorRevision.sourceRevisionId === r.legacyRevisionId && !r.successorRevision.legacyLifecycleHold && r.successorRevision.createdById === r.actedById && r.successorRevision.itemId === r.legacyRevision.itemId, `${r.id}: successor`);
      assert(r.organizationId === r.legacyRevision.organizationId && r.organizationId === r.successorRevision.organizationId, `${r.id}: org`);
    }
    notes.push(`invariants checked over ${rows.length} revalidation rows`);
  });

  notes.push(`concurrency outcomes: ${JSON.stringify(outcomes)}`);
  log("");
  for (const n of notes) log(`NOTE  ${n}`);
  log(`RESULT ${passed} passed, ${failed} failed`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(failed === 0 ? 0 : 1); })
  .catch(async (e) => { log(`FATAL ${e instanceof Error ? e.stack : String(e)}`); await prisma.$disconnect(); process.exit(1); });
