/**
 * B06 live integration gate - REAL PostgreSQL + REAL file storage behaviour
 * of the assembly release guard (app/lib/release-structure-guard-core.ts via
 * app/lib/release-db.ts), the G-2 sign-off, G-3 link removal
 * (app/lib/cad-dependency-remove-db.ts), and the B06 acceptance criterion
 * "Get Latest of that release returns every file with matching SHA-256"
 * (server-side released-workspace plan + the stored bytes).
 *
 * Not part of `npm test`. Talks to the database and a storage folder
 * directly; no dev server. Throwaway data only.
 *
 * SAFETY (same pattern as the B03 gate):
 *  1. BEFORE any connection: DATABASE_URL must be
 *     postgres://...@127.0.0.1|localhost:5432/<db> with no redirecting query
 *     parameters; <db> must equal B06_EXPECTED_DATABASE, match
 *     ^arch_plm_[a-z0-9_]*scratch[a-z0-9_]*$ and not be protected.
 *     B06_STORAGE_ROOT must be an ABSOLUTE path whose last segment matches
 *     the same scratch pattern and that is EMPTY or absent.
 *  2. AFTER connecting, BEFORE any write: current database, server address,
 *     port and system identifier (B06_EXPECTED_SYSTEM_ID) must match; only
 *     ITEST-B06 organizations may exist (run it BEFORE any other fixture);
 *     the schema of all 19 migrations must be present (the 6 append-only
 *     triggers of migrations 18-19 and CadDependency.dependencyType).
 *  3. Every refusal is checked to have written NOTHING (state, events,
 *     baselines unchanged).
 *
 * Run (DATABASE_URL must point at the scratch database):
 *   B06_EXPECTED_DATABASE=<db> B06_EXPECTED_SYSTEM_ID=<id> B06_STORAGE_ROOT=<abs dir> \
 *     node --experimental-strip-types scripts/itest-b06-structure-guard.ts
 *
 * Exit codes: 0 all checks passed; 1 a check failed; 2 target not verified
 * (nothing written).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { CadDocumentType, ItemType, LifecycleState, UserRole } from "../app/generated/prisma/enums.ts";
import {
  ReleaseAttestationRequiredError,
  ReleaseStructureIncompleteError,
  advanceRevisionForActor,
  type ReleaseDb,
} from "../app/lib/release-db.ts";
import { STRUCTURE_ATTESTATION_PHRASE } from "../app/lib/release-structure-guard-core.ts";
import {
  removeCadDependencyForActor,
  type CadDependencyRemovedLog,
} from "../app/lib/cad-dependency-remove-db.ts";
import { ActionRefusalError } from "../app/lib/action-notice-core.ts";
import {
  getReleasedWorkspacePlanForActor,
  type ReleasedWorkspaceDb,
} from "../app/lib/released-workspace-db.ts";
import {
  LocalFilesystemStorage,
  fileVersionStorageKey,
  newUploadNonce,
  sha256Hex,
} from "../app/lib/storage-core.ts";

const S = LifecycleState;
const PROTECTED_DATABASES = new Set(["arch_plm", "arch_plm_m3_scratch", "archplm_dev", "postgres", "template0", "template1"]);
/** A scratch name (database and storage folder): arch_plm_..._scratch_... */
const SCRATCH_NAME = /^arch_plm_[a-z0-9_]*scratch[a-z0-9_]*$/;
/** The 6 append-only triggers created by migrations 18-19 (B03 + Option A):
 *  their presence proves all 19 migrations were applied (HD1 applies them
 *  with psql -f, so there is no _prisma_migrations table to read). */
const EXPECTED_APPEND_ONLY_TRIGGERS = 6;

function log(message: string) {
  console.log(message);
}

// ------------------------------------------------------------
// 1. Pre-connection target check (no PrismaClient exists yet)
// ------------------------------------------------------------

function verifyBeforeConnecting(): string {
  const refuse = (why: string): never => {
    log(`TARGET NOT VERIFIED (before connecting): ${why}`);
    process.exit(2);
  };
  const expectedDb = process.env.B06_EXPECTED_DATABASE ?? "";
  if (!process.env.B06_EXPECTED_SYSTEM_ID) refuse("B06_EXPECTED_SYSTEM_ID is required");
  if (!SCRATCH_NAME.test(expectedDb)) refuse(`B06_EXPECTED_DATABASE '${expectedDb}' is not an arch_plm_*scratch* name`);
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
  if (dbName !== expectedDb) refuse(`URL database '${dbName}' != B06_EXPECTED_DATABASE '${expectedDb}'`);
  for (const key of url.searchParams.keys()) {
    if (!["schema", "connection_limit", "pool_timeout", "connect_timeout", "sslmode"].includes(key)) {
      refuse(`URL query parameter '${key}' is not allowed (could redirect the connection)`);
    }
  }

  const root = process.env.B06_STORAGE_ROOT ?? "";
  if (!path.isAbsolute(root)) refuse("B06_STORAGE_ROOT must be an absolute path");
  if (!SCRATCH_NAME.test(path.basename(root))) refuse(`B06_STORAGE_ROOT folder '${path.basename(root)}' is not an arch_plm_*scratch* name`);
  if (existsSync(root) && readdirSync(root).length > 0) refuse("B06_STORAGE_ROOT is not empty");

  log(`URL CHECK: postgres @ ${url.hostname}:${url.port || "5432"}/${dbName} (credentials not shown)`);
  log(`STORAGE CHECK: ${root} (empty or absent)`);
  return root;
}

const storageRoot = verifyBeforeConnecting();

const prisma = new PrismaClient();
const db = prisma as unknown as ReleaseDb;
const provider = new LocalFilesystemStorage(storageRoot);

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
  const [row] = await prisma.$queryRaw<
    { db: string; sysid: string; addr: string | null; port: number; foreignOrgs: bigint }[]
  >`select current_database() as db,
           (select system_identifier::text from pg_control_system()) as sysid,
           host(inet_server_addr()) as addr,
           inet_server_port() as port,
           (select count(*) from "Organization" where code not like 'ITEST-B06-%') as "foreignOrgs"`;
  const ok =
    row &&
    row.db === process.env.B06_EXPECTED_DATABASE &&
    row.sysid === process.env.B06_EXPECTED_SYSTEM_ID &&
    (row.addr === "127.0.0.1" || row.addr === "::1") &&
    Number(row.port) === 5432 &&
    Number(row.foreignOrgs) === 0;
  if (!ok) {
    log(`TARGET NOT VERIFIED (after connecting): ${JSON.stringify({ ...row, foreignOrgs: row ? Number(row.foreignOrgs) : null })}`);
    await prisma.$disconnect();
    process.exit(2);
  }
  const [schema] = await prisma.$queryRaw<{ triggers: bigint; depType: bigint; anyData: bigint }[]>`
    select (select count(*) from pg_trigger where not tgisinternal and tgname like 'ItemRevision%append_only%') as triggers,
           (select count(*) from information_schema.columns
              where table_name = 'CadDependency' and column_name = 'dependencyType') as "depType",
           (select count(*) from "Organization") as "anyData"`;
  if (Number(schema!.triggers) !== EXPECTED_APPEND_ONLY_TRIGGERS || Number(schema!.depType) !== 1) {
    log(`TARGET NOT VERIFIED: schema incomplete (append-only triggers=${schema!.triggers}, CadDependency.dependencyType=${schema!.depType})`);
    await prisma.$disconnect();
    process.exit(2);
  }
  log(`TARGET VERIFIED: ${row.db} @ ${row.addr}:${row.port} system_identifier=${row.sysid}; only ITEST-B06 data (${schema!.anyData} organizations); all 19 migrations applied (${EXPECTED_APPEND_ONLY_TRIGGERS} append-only triggers)`);
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const rand = randomBytes(4).toString("hex");
type U = { userId: string; organizationId: string; role: UserRole; name: string; email: string };

async function makeOrg(tag: string) {
  return prisma.organization.create({ data: { name: `ITEST B06 ${tag} ${rand}`, code: `ITEST-B06-${tag}-${rand}` } });
}

async function makeUser(organizationId: string, key: string, role: UserRole): Promise<U> {
  const email = `${key}-${rand}@itest-b06.example`;
  const user = await prisma.user.create({ data: { organizationId, email, name: `B06 ${key}`, role, active: true } });
  return { userId: user.id, organizationId, role, name: user.name, email };
}

/** A CAD document with ONE stored, checksummed version (real bytes on disk). */
async function makeDoc(org: string, by: string, number: string, type: CadDocumentType) {
  const ext = type === CadDocumentType.IAM ? "iam" : type === CadDocumentType.IDW ? "idw" : "ipt";
  const doc = await prisma.cadDocument.create({
    data: { organizationId: org, documentNumber: `${number}-${rand}`, fileName: `${number}.${ext}`, documentType: type, createdById: by },
  });
  const bytes = Buffer.from(`B06 itest ${number} ${rand} ${randomBytes(16).toString("hex")}`);
  const storageKey = fileVersionStorageKey({ organizationId: org, cadDocumentId: doc.id, versionNumber: 1, uploadNonce: newUploadNonce() });
  await provider.put(storageKey, bytes);
  const fv = await prisma.fileVersion.create({
    data: {
      organizationId: org, cadDocumentId: doc.id, versionNumber: 1, originalFileName: doc.fileName,
      storageKey, fileSize: BigInt(bytes.length), checksum: sha256Hex(bytes), createdById: by,
    },
  });
  return { id: doc.id, number: doc.documentNumber, fileVersionId: fv.id, sha256: sha256Hex(bytes) };
}

async function link(org: string, by: string, parent: string, child: string, type: "COMPONENT" | "DRAWING_REFERENCE" | "REFERENCE") {
  return prisma.cadDependency.create({
    data: { organizationId: org, parentDocumentId: parent, childDocumentId: child, dependencyType: type, createdById: by },
  });
}

let itemCounter = 0;
/** A revision taken through the REAL lifecycle to APPROVED (B03 rules:
 *  designer creates, engineer submits, approver approves), with documents. */
async function approvedRevision(people: { designer: U; engineer: U; approver: U }, docIds: string[]) {
  itemCounter += 1;
  const org = people.designer.organizationId;
  const item = await prisma.item.create({
    data: { organizationId: org, itemNumber: `B06-${rand}-${itemCounter}`, description: "B06 itest item", type: ItemType.ASSEMBLY },
  });
  const rev = await prisma.itemRevision.create({
    data: { organizationId: org, itemId: item.id, revision: "A", lifecycle: S.WORKING, createdById: people.designer.userId },
  });
  for (const cadDocumentId of docIds) {
    await prisma.itemRevisionDocument.create({
      data: { organizationId: org, itemRevisionId: rev.id, cadDocumentId, createdById: people.designer.userId },
    });
  }
  await advanceRevisionForActor(people.engineer, rev.id, S.IN_REVIEW, db, provider);
  await advanceRevisionForActor(people.approver, rev.id, S.APPROVED, db, provider);
  return rev.id;
}

async function stateOf(revisionId: string) {
  const rev = await prisma.itemRevision.findUniqueOrThrow({ where: { id: revisionId } });
  const events = await prisma.itemRevisionLifecycleEvent.count({ where: { itemRevisionId: revisionId } });
  const baselines = await prisma.releaseBaseline.count({ where: { itemRevisionId: revisionId } });
  return `${rev.lifecycle}|events=${events}|baselines=${baselines}`;
}

async function expectRefused(
  revisionId: string,
  approver: U,
  comment: string | undefined,
  check: (error: unknown) => void,
) {
  const before = await stateOf(revisionId);
  let threw = false;
  try {
    await advanceRevisionForActor(approver, revisionId, S.RELEASED, db, provider, { comment });
  } catch (error) {
    threw = true;
    check(error);
  }
  assert(threw, "release was NOT refused");
  const after = await stateOf(revisionId);
  assert(before === after, `refusal wrote something: ${before} -> ${after}`);
  assert(after.startsWith("APPROVED|"), `state is ${after}`);
}

const ATTEST = `${STRUCTURE_ATTESTATION_PHRASE}: itest ${rand}`;

// ------------------------------------------------------------
// Checks
// ------------------------------------------------------------

async function main() {
  await verifyTargetAfterConnecting();

  const orgA = await makeOrg("A");
  const orgB = await makeOrg("B");
  const people = {
    designer: await makeUser(orgA.id, "designer", UserRole.DESIGNER),
    engineer: await makeUser(orgA.id, "engineer", UserRole.ENGINEER),
    approver: await makeUser(orgA.id, "approver", UserRole.APPROVER),
  };
  const outsider = await makeUser(orgB.id, "outsider", UserRole.ENGINEER);
  const by = people.designer.userId;
  const A = orgA.id;

  await check("B06: an assembly with no recorded components cannot be released; nothing written", async () => {
    const asm = await makeDoc(A, by, "ASM-EMPTY", CadDocumentType.IAM);
    const rev = await approvedRevision(people, [asm.id]);
    await expectRefused(rev, people.approver, ATTEST, (error) => {
      assert(error instanceof ReleaseStructureIncompleteError, `unexpected error ${String(error)}`);
      assert(error.cadDocumentId === asm.id && error.kind === "ASSEMBLY_WITHOUT_COMPONENTS", "wrong gap");
    });
  });

  await check("B06: a nested sub-assembly without components is refused and named", async () => {
    const top = await makeDoc(A, by, "ASM-TOP-GAP", CadDocumentType.IAM);
    const sub = await makeDoc(A, by, "ASM-SUB-GAP", CadDocumentType.IAM);
    const p = await makeDoc(A, by, "PRT-GAP", CadDocumentType.IPT);
    await link(A, by, top.id, sub.id, "COMPONENT");
    await link(A, by, top.id, p.id, "COMPONENT");
    const rev = await approvedRevision(people, [top.id]);
    await expectRefused(rev, people.approver, ATTEST, (error) => {
      assert(error instanceof ReleaseStructureIncompleteError && error.cadDocumentId === sub.id, `expected sub gap, got ${String(error)}`);
    });
  });

  await check("B06: a drawing linked to the revision without a model link is refused", async () => {
    const drw = await makeDoc(A, by, "DRW-NOMODEL", CadDocumentType.IDW);
    const rev = await approvedRevision(people, [drw.id]);
    await expectRefused(rev, people.approver, ATTEST, (error) => {
      assert(error instanceof ReleaseStructureIncompleteError && error.kind === "DRAWING_WITHOUT_MODEL", `got ${String(error)}`);
    });
  });

  // The complete nested assembly used by the next checks.
  const top = await makeDoc(A, by, "ASM-TOP", CadDocumentType.IAM);
  const sub = await makeDoc(A, by, "ASM-SUB", CadDocumentType.IAM);
  const p1 = await makeDoc(A, by, "PRT-1", CadDocumentType.IPT);
  const p2 = await makeDoc(A, by, "PRT-2", CadDocumentType.IPT);
  const p3 = await makeDoc(A, by, "PRT-3", CadDocumentType.IPT);
  const drw = await makeDoc(A, by, "DRW-TOP", CadDocumentType.IDW);
  await link(A, by, top.id, sub.id, "COMPONENT");
  await link(A, by, top.id, p1.id, "COMPONENT");
  const subToP2 = await link(A, by, sub.id, p2.id, "COMPONENT");
  await link(A, by, sub.id, p3.id, "COMPONENT");
  await link(A, by, drw.id, top.id, "DRAWING_REFERENCE");
  const all = [top, sub, p1, p2, p3, drw];

  await check("G-2: a complete assembly without the sign-off comment is refused; nothing written", async () => {
    const rev = await approvedRevision(people, [top.id, drw.id]);
    for (const comment of [undefined, "looks fine", `ok ${STRUCTURE_ATTESTATION_PHRASE}`]) {
      await expectRefused(rev, people.approver, comment, (error) => {
        assert(error instanceof ReleaseAttestationRequiredError, `got ${String(error)}`);
      });
    }
  });

  let releasedRev = "";
  await check("B06: a complete nested structure releases; its baseline contains every component AND the drawing", async () => {
    releasedRev = await approvedRevision(people, [top.id, drw.id]);
    await advanceRevisionForActor(people.approver, releasedRev, S.RELEASED, db, provider, { comment: ATTEST });
    assert((await stateOf(releasedRev)).startsWith("RELEASED|"), "not RELEASED");
    const entries = await prisma.releaseBaselineEntry.findMany({
      where: { releaseBaseline: { itemRevisionId: releasedRev } },
      select: { cadDocumentId: true, fileVersionId: true },
    });
    const got = entries.map((e) => e.cadDocumentId).sort();
    const want = all.map((d) => d.id).sort();
    assert(JSON.stringify(got) === JSON.stringify(want), `baseline ${got.length} docs, expected ${want.length}`);
    const event = await prisma.itemRevisionLifecycleEvent.findFirst({
      where: { itemRevisionId: releasedRev, toState: S.RELEASED },
      select: { comment: true },
    });
    assert(event?.comment === ATTEST, "the sign-off comment is stored on the RELEASED event");
  });

  /** Fetch the released plan and verify every stored file by SHA-256. */
  async function verifyReleasedFiles() {
    const plan = await getReleasedWorkspacePlanForActor(people.approver, releasedRev, prisma as unknown as ReleasedWorkspaceDb, provider);
    assert(plan.entries.length === all.length, `plan has ${plan.entries.length} entries`);
    for (const doc of all) {
      const entry = plan.entries.find((e) => e.cadDocumentId === doc.id);
      assert(entry?.version, `${doc.number} missing from the released plan`);
      assert(entry.version.fileVersionId === doc.fileVersionId, `${doc.number}: wrong version pinned`);
      assert(entry.version.checksum === doc.sha256, `${doc.number}: plan checksum differs`);
      const fv = await prisma.fileVersion.findUniqueOrThrow({ where: { id: doc.fileVersionId }, select: { storageKey: true } });
      const bytes = await provider.get(fv.storageKey);
      assert(sha256Hex(bytes) === doc.sha256, `${doc.number}: stored bytes do not match SHA-256`);
    }
  }

  await check("B06 criterion: Get Latest of that release returns every file with matching SHA-256", verifyReleasedFiles);

  await check("B06-M1 (ii): a drawing NOT linked to the revision is not in the release (documented limitation)", async () => {
    const rev = await approvedRevision(people, [top.id]);
    await advanceRevisionForActor(people.approver, rev, S.RELEASED, db, provider, { comment: ATTEST });
    const docs = (await prisma.releaseBaselineEntry.findMany({
      where: { releaseBaseline: { itemRevisionId: rev } }, select: { cadDocumentId: true },
    })).map((e) => e.cadDocumentId);
    assert(docs.length === 5 && !docs.includes(drw.id), `expected 5 docs without the drawing, got ${docs.length}`);
  });

  await check("G-3: another organization cannot remove the link ('not found'); nothing removed or logged", async () => {
    const logs: CadDependencyRemovedLog[] = [];
    let code = "";
    try {
      await removeCadDependencyForActor(outsider, subToP2.id, prisma, { log: (e) => logs.push(e) });
    } catch (error) {
      code = error instanceof ActionRefusalError ? error.code : String(error);
    }
    assert(code === "CAD_DEPENDENCY_NOT_FOUND", `got ${code || "no refusal"}`);
    assert(logs.length === 0, "logged");
    assert(await prisma.cadDependency.findUnique({ where: { id: subToP2.id } }), "link was removed");
  });

  await check("G-3: removing a link (real FOR UPDATE + SERIALIZABLE) removes it and logs once; the earlier release is unchanged", async () => {
    const logs: CadDependencyRemovedLog[] = [];
    await removeCadDependencyForActor(people.engineer, subToP2.id, prisma, { log: (e) => logs.push(e) });
    assert((await prisma.cadDependency.findUnique({ where: { id: subToP2.id } })) === null, "still there");
    assert(logs.length === 1 && logs[0]!.parentDocumentId === sub.id && logs[0]!.childDocumentId === p2.id, "log entry");
    await verifyReleasedFiles();
  });

  await check("G-3 + B06: after removing the sub-assembly's LAST component link, the next release is refused", async () => {
    const lastLink = await prisma.cadDependency.findFirstOrThrow({
      where: { organizationId: A, parentDocumentId: sub.id, dependencyType: "COMPONENT" },
    });
    await removeCadDependencyForActor(people.engineer, lastLink.id, prisma, { log: () => {} });
    const rev = await approvedRevision(people, [top.id, drw.id]);
    await expectRefused(rev, people.approver, ATTEST, (error) => {
      assert(error instanceof ReleaseStructureIncompleteError && error.cadDocumentId === sub.id, `got ${String(error)}`);
    });
  });

  await check("B06: a parts-only release needs no structure and no sign-off", async () => {
    const part = await makeDoc(A, by, "PRT-ALONE", CadDocumentType.IPT);
    const rev = await approvedRevision(people, [part.id]);
    await advanceRevisionForActor(people.approver, rev, S.RELEASED, db, provider);
    assert((await stateOf(rev)).startsWith("RELEASED|"), "not RELEASED");
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
