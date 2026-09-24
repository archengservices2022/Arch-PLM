/**
 * P6D manual Inventor 2025 IDW acceptance fixture.
 *
 * Creates a small, clearly disposable CAD package IN THE EXISTING ARCH
 * organization from the EXACT bytes of the genuine Inventor files under
 * `C:\Users\skota\ArchPLM\P6D-Accept-Source`, so a human can run CAD
 * Connect's drawing (IDW) Copy Design workflow against real, server-known
 * identities. Based on the SAME supported storage/plan helpers and safety
 * patterns as `scripts/fixture-p6c-manual.ts` (that script is NOT modified -
 * this is a separate, single-purpose script).
 *
 * UNLIKE the P6C fixture, this one exercises the SAME-STEM engineering
 * document number behavior a real model/drawing pair depends on: the root
 * ASSEMBLY (IAM) and the root DRAWING (IDW) are BOTH registered under the
 * documentNumber "P6D-REAL-ROOT" - one as documentType IAM, one as
 * documentType IDW. This is only possible because of the
 * `(organizationId, documentNumber, documentType)` uniqueness rule (as
 * opposed to a bare `(organizationId, documentNumber)` rule, which would
 * reject the second row) - this fixture is a REAL-DATA proof of that
 * behavior, not just the itest scripts' synthetic rows.
 *
 * FOUR documents, one dependency graph:
 *   P6D-REAL-ROOT   (IAM)  -- COMPONENT --> P6D-REAL-PART-A (IPT)
 *   P6D-REAL-ROOT   (IAM)  -- COMPONENT --> P6D-REAL-PART-B (IPT)
 *   P6D-REAL-ROOT   (IDW)  -- DRAWING_REFERENCE --> P6D-REAL-ROOT (IAM)
 *
 * NOTE ON NAMING: the task/Inventor-side (Arch.CadConnect.Core) terminology
 * for the drawing -> model edge is `CadRelationshipKind.DrawingModel`; the
 * WEB repository's own Prisma enum for the identical concept is
 * `CadDependencyType.DRAWING_REFERENCE` ("IDW/DWG drawing references an
 * IAM/IPT model" - see prisma/schema.prisma's own enum doc comment). This
 * script uses the actual Prisma enum value; there is no separate
 * "DRAWING_MODEL" value in this schema.
 *
 * IDENTITY vs. PHYSICAL FILENAME: unlike `fixture-p6c-manual.ts` (which
 * deliberately used a DIFFERENT document-number prefix than the physical
 * source filenames), this fixture's documentNumber IS the filename stem
 * ("P6D-REAL-ROOT" / "P6D-REAL-PART-A" / "P6D-REAL-PART-B") - exactly as the
 * task specified - because proving the SAME documentNumber can carry two
 * documentTypes is the whole point of this fixture.
 *
 * Run from `web/`:
 *   npm run fixture:p6d-manual            # create
 *   npm run fixture:p6d-manual:cleanup    # remove
 *
 * GUARANTEES
 *   - Only rows whose CadDocument.documentNumber starts with "P6D-REAL-" are
 *     ever created or deleted. Every other CadDocument / FileVersion /
 *     CadDependency / CadCheckout / CadCheckoutEvent row (production data,
 *     the P4B/P4C/P6C fixture sets, anything else) is snapshotted (hash)
 *     before and after and asserted UNCHANGED.
 *   - No Prisma schema change, no migration, no product-behaviour change.
 *   - Never reads P6C-Accept-Source or any other fixture's source directory,
 *     never writes into P6D-Accept-Source (read-only).
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
const PREFIX = "P6D-REAL-";
const SOURCE_DIR = "C:\\Users\\skota\\ArchPLM\\P6D-Accept-Source";
const CLEANUP_COMMAND = "npm run fixture:p6d-manual:cleanup";

type CadType = "IAM" | "IPT" | "IDW";

interface DocSpec {
  key: "rootIam" | "rootIdw" | "partA" | "partB";
  documentNumber: string;
  fileName: string;
  documentType: CadType;
  sourcePath: string;
}

const DOCS: DocSpec[] = [
  {
    key: "rootIam",
    documentNumber: `${PREFIX}ROOT`,
    fileName: "P6D-REAL-ROOT.iam",
    documentType: "IAM",
    sourcePath: path.join(SOURCE_DIR, "P6D-REAL-ROOT.iam"),
  },
  {
    key: "partA",
    documentNumber: `${PREFIX}PART-A`,
    fileName: "P6D-REAL-PART-A.ipt",
    documentType: "IPT",
    sourcePath: path.join(SOURCE_DIR, "P6D-REAL-PART-A.ipt"),
  },
  {
    key: "partB",
    documentNumber: `${PREFIX}PART-B`,
    fileName: "P6D-REAL-PART-B.ipt",
    documentType: "IPT",
    sourcePath: path.join(SOURCE_DIR, "P6D-REAL-PART-B.ipt"),
  },
  {
    // Created AFTER rootIam (see main()) so the (documentNumber, documentType)
    // coexistence being proved is "the SAME documentNumber already exists
    // under IAM, does the IDW row still succeed" - the more meaningful order.
    key: "rootIdw",
    documentNumber: `${PREFIX}ROOT`,
    fileName: "P6D-REAL-ROOT.idw",
    documentType: "IDW",
    sourcePath: path.join(SOURCE_DIR, "P6D-REAL-ROOT.idw"),
  },
];

const jsonStable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Hash of every CadDocument / FileVersion / CadDependency / CadCheckout /
 *  CadCheckoutEvent row that is NOT part of THIS fixture (documentNumber
 *  does not start with "P6D-REAL-") - the ARCH baseline (production data,
 *  every OTHER fixture set, including P4B-MANUAL, P4B-REAL, P4C-REAL and
 *  P6C-ACCEPT) this run must not disturb. Checkout + audit rows are included
 *  so a too-broad cleanup would be caught. */
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
 * (documentNumber starting with "P6D-REAL-"), in FK-dependency order
 * (children before parents; every "onDelete: Restrict" parent is emptied of
 * references first). Scoped strictly to the fixture's own CadDocument ids -
 * P4B/P4C/P6C fixture rows and unrelated ARCH data are never touched.
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
        `\nPlace the real Inventor files there (exact names above) and re-run.`,
    );
  }
}

/** Reads the EXACT source bytes - read-only, never writes into
 *  P6D-Accept-Source. */
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
      console.log(`cleanup: removed ${n} P6D-REAL CadDocument(s) + their versions/edges/objects`);
      console.log(`baseline preserved: ${baselineAfter === baselineBefore ? "PASS" : "FAIL"}`);
      return;
    }

    // "verify source files exist" - explicit, BEFORE any DB write.
    await verifySourceFilesExist();

    // Load all source bytes BEFORE any DB write, so a bad path aborts early.
    const sourceBytes = new Map<string, Buffer>();
    for (const spec of DOCS) sourceBytes.set(spec.key, await loadBytes(spec));

    // Idempotent: drop any prior copy of THIS fixture, then rebuild.
    await cleanup(prisma, provider, org.id);
    if ((await baselineRowHash(prisma)) !== baselineBefore) {
      throw new Error("baseline changed during idempotent cleanup - aborting");
    }

    const created: Record<string, {
      id: string; storageKey: string; checksum: string; fileSize: number; fileVersionId: string;
    }> = {};

    for (const spec of DOCS) {
      const bytes = sourceBytes.get(spec.key)!;
      const doc = await prisma.cadDocument.create({
        data: {
          organizationId: org.id,
          documentNumber: spec.documentNumber,
          fileName: spec.fileName,
          documentType: spec.documentType,
          description: "P6D manual IDW acceptance fixture - disposable",
          createdById: user.id,
        },
      });
      const stored = await storeCadFileVersionForActor(
        actor, doc.id, Readable.from(bytes), spec.fileName, maxBytes, prisma, provider,
      );
      created[spec.key] = {
        id: doc.id,
        storageKey: stored.storageKey,
        checksum: stored.checksum,
        fileSize: stored.fileSize,
        fileVersionId: stored.fileVersionId,
      };
    }

    // ---- dependency edges ---------------------------------------------
    for (const child of ["partA", "partB"] as const) {
      await prisma.cadDependency.create({
        data: {
          organizationId: org.id,
          parentDocumentId: created.rootIam.id,
          childDocumentId: created[child].id,
          dependencyType: "COMPONENT",
          createdById: user.id,
        },
      });
    }
    await prisma.cadDependency.create({
      data: {
        organizationId: org.id,
        parentDocumentId: created.rootIdw.id,
        childDocumentId: created.rootIam.id,
        dependencyType: "DRAWING_REFERENCE",
        createdById: user.id,
      },
    });

    // ---- verification ---------------------------------------------------

    // Same-documentNumber IAM+IDW coexistence - queried fresh from the DB,
    // never assumed from the create() calls above succeeding.
    const rootRows = await prisma.cadDocument.findMany({
      where: { organizationId: org.id, documentNumber: DOCS[0].documentNumber },
      select: { id: true, documentType: true },
    });
    const coexistOk =
      rootRows.length === 2 &&
      new Set(rootRows.map((r) => r.documentType)).size === 2 &&
      new Set(rootRows.map((r) => r.documentType)).has("IAM") &&
      new Set(rootRows.map((r) => r.documentType)).has("IDW") &&
      rootRows.find((r) => r.documentType === "IAM")?.id === created.rootIam.id &&
      rootRows.find((r) => r.documentType === "IDW")?.id === created.rootIdw.id;

    // Workspace plan rooted at the DRAWING - Get Latest traverses EVERY
    // CadDependency row regardless of type, so this closure is the FULL
    // four-document graph (IDW -> [DRAWING_REFERENCE] -> IAM -> [COMPONENT]
    // -> PART-A, PART-B), proving the drawing pulls in its complete
    // transitive model closure.
    const plan = await getWorkspacePlanForActor(actor, created.rootIdw.id, prisma, provider);
    const expectedClosure = new Set(Object.values(created).map((c) => c.id));
    const planClosure = new Set(plan.entries.map((e) => e.cadDocumentId));
    const closureOk =
      planClosure.size === expectedClosure.size &&
      [...expectedClosure].every((id) => planClosure.has(id));

    const rootIdwEntry = plan.entries.find((e) => e.cadDocumentId === created.rootIdw.id);
    const rootIamEntry = plan.entries.find((e) => e.cadDocumentId === created.rootIam.id);
    const edgesOk =
      rootIdwEntry?.dependsOn.some((d) => d.cadDocumentId === created.rootIam.id && d.dependencyType === "DRAWING_REFERENCE") === true &&
      rootIamEntry?.dependsOn.some((d) => d.cadDocumentId === created.partA.id && d.dependencyType === "COMPONENT") === true &&
      rootIamEntry?.dependsOn.some((d) => d.cadDocumentId === created.partB.id && d.dependencyType === "COMPONENT") === true;

    const planOk =
      plan.contract.id === WORKSPACE_PLAN_CONTRACT_ID &&
      plan.contract.version === WORKSPACE_PLAN_CONTRACT_VERSION &&
      plan.safe === true &&
      plan.entries.length === DOCS.length &&
      closureOk &&
      edgesOk &&
      plan.entries.every((e) => e.canMaterialize && e.version !== null) &&
      plan.entries.find((e) => e.isRoot)?.cadDocumentId === created.rootIdw.id &&
      plan.entries.every((e) => e.version!.contentPath === `/api/file-versions/${e.version!.fileVersionId}/content`);

    let sourceMatchOk = true;
    let binaryOk = true;
    for (const spec of DOCS) {
      const c = created[spec.key];
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
    console.log("P6D MANUAL FIXTURE READY");
    line("Organization:", `${org.name} (${ORG_CODE})`);
    console.log("");
    console.log("Per-document detail (documentNumber | documentType | physical fileName | cadDocumentId | v1 fileVersionId | sha256 | bytes):");
    for (const spec of DOCS) {
      const c = created[spec.key];
      console.log(`  ${spec.documentNumber}  ${spec.documentType}  ${spec.fileName}  ${c.id}  ${c.fileVersionId}  ${c.checksum}  ${c.fileSize}`);
    }
    console.log("");
    console.log("Dependency edges:");
    console.log(`  ${DOCS[0].documentNumber} (IAM) -> ${DOCS[1].documentNumber} (IPT)  [COMPONENT]`);
    console.log(`  ${DOCS[0].documentNumber} (IAM) -> ${DOCS[2].documentNumber} (IPT)  [COMPONENT]`);
    console.log(`  ${DOCS[3].documentNumber} (IDW) -> ${DOCS[0].documentNumber} (IAM)  [DRAWING_REFERENCE]`);
    line("Exact source byte match:", sourceMatchOk ? "PASS" : "FAIL");
    line("Same-documentNumber IAM+IDW coexistence:", coexistOk ? "PASS" : "FAIL");
    line("Workspace-plan package count:", String(plan.entries.length));
    line("Dependency closure = ROOT IAM + ROOT IDW + PART-A + PART-B:", closureOk ? "PASS" : "FAIL");
    line("Workspace-plan check:", planOk ? "PASS" : "FAIL");
    line("Binary retrieval check:", binaryOk ? "PASS" : "FAIL");
    line("Baseline preservation:", baselineOk ? "PASS" : "FAIL");
    line("Cleanup command:", CLEANUP_COMMAND);

    if (!planOk || !binaryOk || !baselineOk || !sourceMatchOk || !closureOk || !coexistOk) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("fixture failed:", error);
  process.exit(1);
});
