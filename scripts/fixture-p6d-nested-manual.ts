/**
 * P6D FINAL MANUAL ACCEPTANCE - nested/multiple-subassembly Copy Design
 * fixture. Creates a disposable, clearly-scoped CAD package IN THE EXISTING
 * ARCH organization from the EXACT bytes of the genuine Inventor files under
 * `C:\Users\skota\ArchPLM\P6D-Nested-Accept-Source`, so a human can run CAD
 * Connect's full recursive Copy Design workflow (Get Latest -> Preview ->
 * Apply -> Resume) against a REAL, server-known, multi-level assembly
 * closure. Modeled directly on `scripts/fixture-p6d-manual.ts` (that script
 * is NOT modified - this is a separate, single-purpose script covering a
 * DIFFERENT, deeper shape: two levels of subassembly nesting, three leaf
 * parts, one drawing).
 *
 * SEVEN documents, SIX dependency edges (a tree - MAIN.idw is the entry
 * point, MAIN.iam is shared by both the drawing and the two subassemblies):
 *
 *   P6D-NESTED-MAIN (IDW) --DRAWING_REFERENCE--> P6D-NESTED-MAIN (IAM)
 *   P6D-NESTED-MAIN (IAM) --COMPONENT--> P6D-NESTED-SUB-A (IAM)
 *   P6D-NESTED-MAIN (IAM) --COMPONENT--> P6D-NESTED-SUB-B (IAM)
 *   P6D-NESTED-SUB-A (IAM) --COMPONENT--> P6D-NESTED-A1 (IPT)
 *   P6D-NESTED-SUB-A (IAM) --COMPONENT--> P6D-NESTED-A2 (IPT)
 *   P6D-NESTED-SUB-B (IAM) --COMPONENT--> P6D-NESTED-B1 (IPT)
 *
 * SAME-STEM IAM+IDW coexistence (as fixture-p6d-manual.ts already proved
 * for the flat case) is proved again here: MAIN.iam and MAIN.idw share the
 * documentNumber "P6D-NESTED-MAIN" under two different documentTypes.
 *
 * Run from `web/`:
 *   npm run fixture:p6d-nested-manual            # create
 *   npm run fixture:p6d-nested-manual:cleanup    # remove
 *
 * GUARANTEES
 *   - Only rows whose CadDocument.documentNumber starts with "P6D-NESTED-"
 *     are ever created or deleted. Every other CadDocument / FileVersion /
 *     CadDependency / CadCheckout / CadCheckoutEvent row (production data,
 *     every other fixture set including the flat P6D-REAL-* one) is
 *     snapshotted (hash) before and after and asserted UNCHANGED.
 *   - No Prisma schema change, no migration, no product-behaviour change.
 *   - Never reads/writes P6D-Accept-Source or any other fixture's source
 *     directory - only reads (read-only) from P6D-Nested-Accept-Source.
 *   - Real CadDocument + FileVersion rows, real binary objects with a
 *     correct size + SHA-256 + server-generated storageKey, retrievable
 *     content that byte-matches its source.
 *   - Does NOT launch Inventor.
 *
 * Security: never prints a token, cookie, password or absolute storage path.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import {
  LocalFilesystemStorage,
  resolveMaxUploadBytes,
  resolveStorageRoot,
} from "../app/lib/storage-core.ts";
import { storeCadFileVersionForActor } from "../app/lib/upload-guard-db.ts";
import { getWorkspacePlanForActor } from "../app/lib/workspace-plan-db.ts";
import {
  WORKSPACE_PLAN_CONTRACT_ID,
  WORKSPACE_PLAN_CONTRACT_VERSION,
} from "../app/lib/workspace-plan-core.ts";

const ORG_CODE = "ARCH";
const PREFIX = "P6D-NESTED-";
const SOURCE_DIR = "C:\\Users\\skota\\ArchPLM\\P6D-Nested-Accept-Source";
const CLEANUP_COMMAND = "npm run fixture:p6d-nested-manual:cleanup";

type CadType = "IAM" | "IPT" | "IDW";
type Key = "mainIam" | "mainIdw" | "subA" | "subB" | "a1" | "a2" | "b1";

interface DocSpec {
  key: Key;
  documentNumber: string;
  fileName: string;
  documentType: CadType;
  sourcePath: string;
}

const DOCS: DocSpec[] = [
  // Leaves first, then subassemblies, then MAIN.iam, then MAIN.idw LAST -
  // same "prove the more meaningful order" reasoning as fixture-p6d-manual.ts:
  // MAIN.idw is created after a same-documentNumber MAIN.iam already exists.
  { key: "a1", documentNumber: `${PREFIX}A1`, fileName: "P6D-NESTED-A1.ipt", documentType: "IPT", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-A1.ipt") },
  { key: "a2", documentNumber: `${PREFIX}A2`, fileName: "P6D-NESTED-A2.ipt", documentType: "IPT", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-A2.ipt") },
  { key: "b1", documentNumber: `${PREFIX}B1`, fileName: "P6D-NESTED-B1.ipt", documentType: "IPT", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-B1.ipt") },
  { key: "subA", documentNumber: `${PREFIX}SUB-A`, fileName: "P6D-NESTED-SUB-A.iam", documentType: "IAM", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-SUB-A.iam") },
  { key: "subB", documentNumber: `${PREFIX}SUB-B`, fileName: "P6D-NESTED-SUB-B.iam", documentType: "IAM", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-SUB-B.iam") },
  { key: "mainIam", documentNumber: `${PREFIX}MAIN`, fileName: "P6D-NESTED-MAIN.iam", documentType: "IAM", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-MAIN.iam") },
  { key: "mainIdw", documentNumber: `${PREFIX}MAIN`, fileName: "P6D-NESTED-MAIN.idw", documentType: "IDW", sourcePath: path.join(SOURCE_DIR, "P6D-NESTED-MAIN.idw") },
];

/** parentKey --COMPONENT/DRAWING_REFERENCE--> childKey */
const EDGES: Array<{ parent: Key; child: Key; type: "COMPONENT" | "DRAWING_REFERENCE" }> = [
  { parent: "mainIdw", child: "mainIam", type: "DRAWING_REFERENCE" },
  { parent: "mainIam", child: "subA", type: "COMPONENT" },
  { parent: "mainIam", child: "subB", type: "COMPONENT" },
  { parent: "subA", child: "a1", type: "COMPONENT" },
  { parent: "subA", child: "a2", type: "COMPONENT" },
  { parent: "subB", child: "b1", type: "COMPONENT" },
];

const jsonStable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Hash of every CadDocument / FileVersion / CadDependency / CadCheckout /
 *  CadCheckoutEvent row that is NOT part of THIS fixture (documentNumber
 *  does not start with "P6D-NESTED-") - the ARCH baseline (production data,
 *  every OTHER fixture set, including the flat P6D-REAL-* fixture) this run
 *  must not disturb. Checkout + audit rows are included so a too-broad
 *  cleanup would be caught. */
async function baselineRowHash(prisma: PrismaClient): Promise<string> {
  const notFixtureDoc = { is: { NOT: { documentNumber: { startsWith: PREFIX } } } };
  const [docs, fvs, deps, checkouts, events] = await Promise.all([
    prisma.cadDocument.findMany({ where: { NOT: { documentNumber: { startsWith: PREFIX } } }, orderBy: { id: "asc" } }),
    prisma.fileVersion.findMany({ where: { cadDocument: notFixtureDoc }, orderBy: { id: "asc" } }),
    prisma.cadDependency.findMany({
      where: { AND: [{ parentDocument: notFixtureDoc }, { childDocument: notFixtureDoc }] },
      orderBy: { id: "asc" },
    }),
    prisma.cadCheckout.findMany({ where: { cadDocument: notFixtureDoc }, orderBy: { id: "asc" } }),
    prisma.cadCheckoutEvent.findMany({ where: { cadDocument: notFixtureDoc }, orderBy: { id: "asc" } }),
  ]);
  return createHash("sha256").update(jsonStable({ docs, fvs, deps, checkouts, events })).digest("hex");
}

/**
 * Remove EVERY row + storage object that belongs to THIS disposable fixture
 * (documentNumber starting with "P6D-NESTED-"), in FK-dependency order
 * (children before parents; every "onDelete: Restrict" parent is emptied of
 * references first). Scoped strictly to the fixture's own CadDocument ids -
 * every other fixture set and unrelated ARCH data is never touched.
 * Idempotent: every step is a `deleteMany` that no-ops when nothing matches,
 * so a partially-completed run finishes cleanly on the next call.
 */
async function cleanup(
  prisma: PrismaClient,
  provider: LocalFilesystemStorage,
  organizationId: string,
): Promise<number> {
  const docRows = await prisma.cadDocument.findMany({
    where: { organizationId, documentNumber: { startsWith: PREFIX } },
    select: { id: true },
  });
  const docIds = docRows.map((r) => r.id);

  const fvRows = docIds.length === 0
    ? []
    : await prisma.fileVersion.findMany({
        where: { organizationId, cadDocumentId: { in: docIds } },
        select: { id: true, storageKey: true },
      });
  const fvIds = fvRows.map((r) => r.id);

  // A `{ id: { in: [] } }` filter matches nothing, so every step below is a
  // safe no-op when the fixture is already (partly) gone.
  const inDocs = { in: docIds };
  const inFvs = { in: fvIds };

  // 1. active checkout rows for fixture documents (baseFileVersion FK Restrict).
  await prisma.cadCheckout.deleteMany({ where: { organizationId, cadDocumentId: inDocs } });

  // 2. checkout AUDIT events - scoped to fixture documents / fixture
  //    FileVersions ONLY (cadDocumentId + baseFileVersionId are both
  //    onDelete: Restrict).
  await prisma.cadCheckoutEvent.deleteMany({
    where: { organizationId, OR: [{ cadDocumentId: inDocs }, { baseFileVersionId: inFvs }] },
  });

  // 3. other fixture-owned dependents of CadDocument.
  await prisma.cadDependency.deleteMany({
    where: { organizationId, OR: [{ parentDocumentId: inDocs }, { childDocumentId: inDocs }] },
  });
  await prisma.itemRevisionDocument.deleteMany({ where: { organizationId, cadDocumentId: inDocs } });

  // 4. fixture FileVersions - now unreferenced.
  await prisma.fileVersion.deleteMany({ where: { organizationId, cadDocumentId: inDocs } });

  // 5. fixture CadDocuments.
  await prisma.cadDocument.deleteMany({ where: { organizationId, id: inDocs } });

  // 6. fixture storage objects + empty dirs (best effort, already-gone is fine).
  for (const { storageKey } of fvRows) {
    try { await provider.delete(storageKey); } catch { /* best effort */ }
  }
  await pruneEmptyStorageDirs();

  return docIds.length;
}

async function pruneEmptyStorageDirs(): Promise<void> {
  const root = resolveStorageRoot();
  if (!(await stat(root).then(() => true).catch(() => false))) return;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
    try {
      if (dir !== root && (await readdir(dir)).length === 0) await rm(dir, { recursive: false });
    } catch { /* best effort */ }
  };
  await walk(root);
}

/** Fails fast, BEFORE any database write, naming every missing file and the
 *  expected source directory - "verify source files exist" as an explicit,
 *  friendly check rather than letting a raw ENOENT surface later. */
async function verifySourceFilesExist(): Promise<void> {
  const missing: string[] = [];
  for (const spec of DOCS) {
    const exists = await stat(spec.sourcePath).then((s) => s.isFile()).catch(() => false);
    if (!exists) missing.push(spec.sourcePath);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.length} required source file(s) under "${SOURCE_DIR}":\n` +
        missing.map((p) => `  - ${path.basename(p)}`).join("\n") +
        `\nCreate the real nested Inventor files there (exact names above - see ` +
        `P6D-Nested-Accept-Source\\CreateP6DNestedFixture.vba) and re-run.`,
    );
  }
}

/** Reads the EXACT source bytes - read-only, never writes into
 *  P6D-Nested-Accept-Source. */
async function loadBytes(spec: DocSpec): Promise<Buffer> {
  const buf = await readFile(spec.sourcePath);
  if (buf.length === 0) throw new Error(`Source file is empty: ${spec.sourcePath}`);
  return buf;
}

async function main(): Promise<void> {
  const isCleanup = process.argv.includes("--cleanup");

  const prisma = new PrismaClient();
  const provider = new LocalFilesystemStorage(resolveStorageRoot());
  const maxBytes = resolveMaxUploadBytes();

  try {
    const org = await prisma.organization.findUnique({ where: { code: ORG_CODE }, select: { id: true, name: true } });
    if (!org) throw new Error(`Organization "${ORG_CODE}" not found - nothing to do.`);

    const user = await prisma.user.findFirst({
      where: { organizationId: org.id, active: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { createdAt: "asc" },
    });
    if (!user) throw new Error(`No active user in "${ORG_CODE}" - cannot own the fixture.`);
    const actor = { userId: user.id, organizationId: org.id, role: user.role, name: user.name, email: user.email };

    const baselineBefore = await baselineRowHash(prisma);

    if (isCleanup) {
      const n = await cleanup(prisma, provider, org.id);
      const baselineAfter = await baselineRowHash(prisma);
      console.log(`cleanup: removed ${n} P6D-NESTED CadDocument(s) + their versions/edges/objects`);
      console.log(`baseline preserved: ${baselineAfter === baselineBefore ? "PASS" : "FAIL"}`);
      return;
    }

    // "verify source files exist" - explicit, BEFORE any DB write.
    await verifySourceFilesExist();

    // Load all source bytes BEFORE any DB write, so a bad path aborts early.
    const sourceBytes = new Map<Key, Buffer>();
    for (const spec of DOCS) sourceBytes.set(spec.key, await loadBytes(spec));

    // Idempotent: drop any prior copy of THIS fixture, then rebuild.
    await cleanup(prisma, provider, org.id);
    if ((await baselineRowHash(prisma)) !== baselineBefore) {
      throw new Error("baseline changed during idempotent cleanup - aborting");
    }

    const created = new Map<Key, {
      id: string; storageKey: string; checksum: string; fileSize: number; fileVersionId: string;
    }>();

    for (const spec of DOCS) {
      const bytes = sourceBytes.get(spec.key)!;
      const doc = await prisma.cadDocument.create({
        data: {
          organizationId: org.id,
          documentNumber: spec.documentNumber,
          fileName: spec.fileName,
          documentType: spec.documentType,
          description: "P6D nested/multiple-subassembly acceptance fixture - disposable",
          createdById: user.id,
        },
      });
      const stored = await storeCadFileVersionForActor(
        actor, doc.id, Readable.from(bytes), spec.fileName, maxBytes, prisma, provider,
      );
      created.set(spec.key, {
        id: doc.id,
        storageKey: stored.storageKey,
        checksum: stored.checksum,
        fileSize: stored.fileSize,
        fileVersionId: stored.fileVersionId,
      });
    }

    // ---- dependency edges - EXACTLY the 6 authoritative edges, never
    //      inferred from file names. --------------------------------------
    for (const edge of EDGES) {
      await prisma.cadDependency.create({
        data: {
          organizationId: org.id,
          parentDocumentId: created.get(edge.parent)!.id,
          childDocumentId: created.get(edge.child)!.id,
          dependencyType: edge.type,
          createdById: user.id,
        },
      });
    }

    // ---- verification ---------------------------------------------------

    // Same-documentNumber IAM+IDW coexistence for MAIN - queried fresh from
    // the DB, never assumed from the create() calls above succeeding.
    const mainRows = await prisma.cadDocument.findMany({
      where: { organizationId: org.id, documentNumber: `${PREFIX}MAIN` },
      select: { id: true, documentType: true },
    });
    const coexistOk =
      mainRows.length === 2 &&
      new Set(mainRows.map((r) => r.documentType)).size === 2 &&
      new Set(mainRows.map((r) => r.documentType)).has("IAM") &&
      new Set(mainRows.map((r) => r.documentType)).has("IDW") &&
      mainRows.find((r) => r.documentType === "IAM")?.id === created.get("mainIam")!.id &&
      mainRows.find((r) => r.documentType === "IDW")?.id === created.get("mainIdw")!.id;

    // Workspace plan rooted at the DRAWING - Get Latest traverses EVERY
    // CadDependency row regardless of type, so this closure is the FULL
    // seven-document graph (IDW -> [DRAWING_REFERENCE] -> MAIN IAM ->
    // [COMPONENT] -> SUB-A, SUB-B -> [COMPONENT] -> A1, A2, B1), proving the
    // drawing pulls in its complete, TWO-LEVEL transitive model closure.
    const plan = await getWorkspacePlanForActor(actor, created.get("mainIdw")!.id, prisma, provider);
    const expectedClosure = new Set([...created.values()].map((c) => c.id));
    const planClosure = new Set(plan.entries.map((e) => e.cadDocumentId));
    const closureOk =
      planClosure.size === 7 &&
      expectedClosure.size === 7 &&
      [...expectedClosure].every((id) => planClosure.has(id));

    const edgesOk = EDGES.every((edge) => {
      const parentEntry = plan.entries.find((e) => e.cadDocumentId === created.get(edge.parent)!.id);
      return parentEntry?.dependsOn.some(
        (d) => d.cadDocumentId === created.get(edge.child)!.id && d.dependencyType === edge.type,
      ) === true;
    });

    const planOk =
      plan.contract.id === WORKSPACE_PLAN_CONTRACT_ID &&
      plan.contract.version === WORKSPACE_PLAN_CONTRACT_VERSION &&
      plan.safe === true &&
      plan.entries.length === DOCS.length &&
      closureOk &&
      edgesOk &&
      plan.entries.every((e) => e.canMaterialize && e.version !== null) &&
      plan.entries.find((e) => e.isRoot)?.cadDocumentId === created.get("mainIdw")!.id &&
      plan.entries.every((e) => e.version!.contentPath === `/api/file-versions/${e.version!.fileVersionId}/content`);

    let sourceMatchOk = true;
    let binaryOk = true;
    for (const spec of DOCS) {
      const c = created.get(spec.key)!;
      const src = sourceBytes.get(spec.key)!;

      // stored row metadata is derived from the real bytes
      if (c.checksum !== sha256Hex(src) || c.fileSize !== src.length) sourceMatchOk = false;

      // provider agrees, and a retrieval byte-matches the source
      const hashed = await provider.hashObject(c.storageKey);
      const { stream } = await provider.openReadStream(c.storageKey);
      const chunks: Buffer[] = [];
      for await (const ch of stream) chunks.push(ch as Buffer);
      const readBack = Buffer.concat(chunks);

      if (hashed.sha256 !== c.checksum || hashed.size !== c.fileSize) binaryOk = false;
      if (!readBack.equals(src)) { binaryOk = false; sourceMatchOk = false; }
    }

    const baselineOk = (await baselineRowHash(prisma)) === baselineBefore;

    const line = (label: string, value: string) => { console.log(""); console.log(label); console.log(value); };
    console.log("");
    console.log("P6D NESTED MANUAL FIXTURE READY");
    line("Organization:", `${org.name} (${ORG_CODE})`);
    console.log("");
    console.log("Per-document detail (documentNumber | documentType | physical fileName | cadDocumentId | v1 fileVersionId | sha256 | bytes):");
    for (const spec of DOCS) {
      const c = created.get(spec.key)!;
      console.log(`  ${spec.documentNumber}  ${spec.documentType}  ${spec.fileName}  ${c.id}  ${c.fileVersionId}  ${c.checksum}  ${c.fileSize}`);
    }
    console.log("");
    console.log("Dependency edges:");
    for (const edge of EDGES) {
      const p = DOCS.find((d) => d.key === edge.parent)!;
      const cSpec = DOCS.find((d) => d.key === edge.child)!;
      console.log(`  ${p.documentNumber} (${p.documentType}) -> ${cSpec.documentNumber} (${cSpec.documentType})  [${edge.type}]`);
    }
    line("Exact source byte match (all 7):", sourceMatchOk ? "PASS" : "FAIL");
    line("Same-documentNumber MAIN IAM+IDW coexistence:", coexistOk ? "PASS" : "FAIL");
    line("Workspace-plan package count:", String(plan.entries.length));
    line("Dependency closure = exactly 7 expected documents:", closureOk ? "PASS" : "FAIL");
    line("All 6 authoritative dependency edges present:", edgesOk ? "PASS" : "FAIL");
    line("Workspace-plan check:", planOk ? "PASS" : "FAIL");
    line("Binary retrieval check:", binaryOk ? "PASS" : "FAIL");
    line("Baseline preservation (all other ARCH data untouched):", baselineOk ? "PASS" : "FAIL");
    line("Cleanup command:", CLEANUP_COMMAND);

    if (!planOk || !binaryOk || !baselineOk || !sourceMatchOk || !closureOk || !coexistOk || !edgesOk) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("fixture failed:", error);
  process.exit(1);
});
