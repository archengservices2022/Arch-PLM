/**
 * P4B manual Inventor 2025 acceptance fixture.
 *
 * Creates a small, clearly disposable CAD package IN THE EXISTING ARCH
 * organization so a human can run `ARCH ENGINEERING > Get Latest` from the
 * loaded CAD Connect add-in against real data. Reuses the same supported
 * storage/plan helpers as the P4B live integration gate
 * (`scripts/itest-p4b-get-latest.ts`).
 *
 * Two disposable sets, each with its own document-number prefix so they are
 * fully independent and neither touches the other (or production data):
 *
 *   default        P4B-MANUAL-*   synthetic random binaries
 *   --real         P4B-REAL-*     the EXACT bytes of genuine Inventor 2025
 *                                 files under C:\Users\skota\ArchPLM\P4B-Real-Source
 *
 * Run from `web/`:
 *   npm run fixture:p4b-manual                 # create P4B-MANUAL-* (+verify)
 *   npm run fixture:p4b-manual:cleanup         # remove P4B-MANUAL-*
 *   npm run fixture:p4b-real                   # create P4B-REAL-*   (+verify)
 *   npm run fixture:p4b-real:cleanup           # remove P4B-REAL-*
 *
 * GUARANTEES
 *   - Only rows whose CadDocument.documentNumber starts with the ACTIVE
 *     prefix are ever created or deleted. Every other CadDocument /
 *     FileVersion / CadDependency row (production 10073*, and the OTHER
 *     fixture set) is snapshotted (hash) before and after and asserted
 *     UNCHANGED.
 *   - No Prisma schema change, no migration, no product-behaviour change.
 *   - Real CadDocument + FileVersion rows, real binary objects with a correct
 *     size + SHA-256 + server-generated storageKey, retrievable content that
 *     byte-matches its source.
 *
 * Security: never prints a token, cookie, password or absolute storage path.
 */
import { createHash, randomBytes } from "node:crypto";
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

const ORG_CODE = "ARCH";
const REAL_SOURCE_DIR = "C:\\Users\\skota\\ArchPLM\\P4B-Real-Source";

type CadType = "IAM" | "IPT";

interface DocSpec {
  key: "root" | "partA" | "partB";
  documentNumber: string;
  fileName: string;
  documentType: CadType;
  isRoot: boolean;
  /** Absolute path to genuine source bytes; when absent, synthetic random. */
  sourcePath?: string;
}

interface FixtureSet {
  name: string;
  prefix: string;
  cleanupCommand: string;
  docs: DocSpec[];
}

const MANUAL_SET: FixtureSet = {
  name: "P4B-MANUAL",
  prefix: "P4B-MANUAL-",
  cleanupCommand: "npm run fixture:p4b-manual:cleanup",
  docs: [
    { key: "root", documentNumber: "P4B-MANUAL-ROOT", fileName: "P4B-MANUAL-ROOT.iam", documentType: "IAM", isRoot: true },
    { key: "partA", documentNumber: "P4B-MANUAL-PART-A", fileName: "P4B-MANUAL-PART-A.ipt", documentType: "IPT", isRoot: false },
    { key: "partB", documentNumber: "P4B-MANUAL-PART-B", fileName: "P4B-MANUAL-PART-B.ipt", documentType: "IPT", isRoot: false },
  ],
};

const REAL_SET: FixtureSet = {
  name: "P4B-REAL",
  prefix: "P4B-REAL-",
  cleanupCommand: "npm run fixture:p4b-real:cleanup",
  docs: [
    { key: "root", documentNumber: "P4B-REAL-ROOT", fileName: "P4B-REAL-ROOT.iam", documentType: "IAM", isRoot: true, sourcePath: path.join(REAL_SOURCE_DIR, "P4B-REAL-ROOT.iam") },
    { key: "partA", documentNumber: "P4B-REAL-PART-A", fileName: "P4B-REAL-PART-A.ipt", documentType: "IPT", isRoot: false, sourcePath: path.join(REAL_SOURCE_DIR, "P4B-REAL-PART-A.ipt") },
    { key: "partB", documentNumber: "P4B-REAL-PART-B", fileName: "P4B-REAL-PART-B.ipt", documentType: "IPT", isRoot: false, sourcePath: path.join(REAL_SOURCE_DIR, "P4B-REAL-PART-B.ipt") },
  ],
};

const jsonStable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Hash of every CadDocument / FileVersion / CadDependency row that is NOT
 *  part of THIS fixture set - the ARCH baseline this run must not disturb
 *  (production data and the other fixture set are both inside it). */
async function baselineRowHash(prisma: PrismaClient, prefix: string): Promise<string> {
  const docs = await prisma.cadDocument.findMany({
    where: { NOT: { documentNumber: { startsWith: prefix } } },
    orderBy: { id: "asc" },
  });
  const fvs = await prisma.fileVersion.findMany({
    where: { cadDocument: { is: { NOT: { documentNumber: { startsWith: prefix } } } } },
    orderBy: { id: "asc" },
  });
  const deps = await prisma.cadDependency.findMany({
    where: {
      AND: [
        { parentDocument: { is: { NOT: { documentNumber: { startsWith: prefix } } } } },
        { childDocument: { is: { NOT: { documentNumber: { startsWith: prefix } } } } },
      ],
    },
    orderBy: { id: "asc" },
  });
  return createHash("sha256").update(jsonStable({ docs, fvs, deps })).digest("hex");
}

async function cleanup(
  prisma: PrismaClient,
  provider: LocalFilesystemStorage,
  organizationId: string,
  prefix: string,
): Promise<number> {
  const rows = await prisma.cadDocument.findMany({
    where: { organizationId, documentNumber: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;

  const fvs = await prisma.fileVersion.findMany({
    where: { organizationId, cadDocumentId: { in: ids } },
    select: { storageKey: true },
  });

  await prisma.cadDependency.deleteMany({
    where: { organizationId, OR: [{ parentDocumentId: { in: ids } }, { childDocumentId: { in: ids } }] },
  });
  await prisma.itemRevisionDocument.deleteMany({ where: { organizationId, cadDocumentId: { in: ids } } });
  await prisma.fileVersion.deleteMany({ where: { organizationId, cadDocumentId: { in: ids } } });
  await prisma.cadDocument.deleteMany({ where: { organizationId, id: { in: ids } } });

  for (const { storageKey } of fvs) {
    try { await provider.delete(storageKey); } catch { /* best effort */ }
  }
  await pruneEmptyStorageDirs();
  return ids.length;
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

async function loadBytes(spec: DocSpec): Promise<Buffer> {
  if (spec.sourcePath) {
    const buf = await readFile(spec.sourcePath);
    if (buf.length === 0) throw new Error(`Source file is empty: ${spec.sourcePath}`);
    return buf;
  }
  return randomBytes(6144 + Math.floor(Math.random() * 2048));
}

async function main(): Promise<void> {
  const isCleanup = process.argv.includes("--cleanup");
  const set = process.argv.includes("--real") ? REAL_SET : MANUAL_SET;

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

    const baselineBefore = await baselineRowHash(prisma, set.prefix);

    if (isCleanup) {
      const n = await cleanup(prisma, provider, org.id, set.prefix);
      const baselineAfter = await baselineRowHash(prisma, set.prefix);
      console.log(`cleanup: removed ${n} ${set.name} CadDocument(s) + their versions/edges/objects`);
      console.log(`baseline preserved: ${baselineAfter === baselineBefore ? "PASS" : "FAIL"}`);
      return;
    }

    // Load all source bytes BEFORE any DB write, so a bad path aborts early.
    const sourceBytes = new Map<string, Buffer>();
    for (const spec of set.docs) sourceBytes.set(spec.key, await loadBytes(spec));

    // Idempotent: drop any prior copy of THIS set, then rebuild.
    await cleanup(prisma, provider, org.id, set.prefix);
    if ((await baselineRowHash(prisma, set.prefix)) !== baselineBefore) {
      throw new Error("baseline changed during idempotent cleanup - aborting");
    }

    const created: Record<string, {
      id: string; storageKey: string; checksum: string; fileSize: number; fileVersionId: string;
    }> = {};

    for (const spec of set.docs) {
      const bytes = sourceBytes.get(spec.key)!;
      const doc = await prisma.cadDocument.create({
        data: {
          organizationId: org.id,
          documentNumber: spec.documentNumber,
          fileName: spec.fileName,
          documentType: spec.documentType,
          description: `${set.name} acceptance fixture - disposable`,
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

    for (const child of ["partA", "partB"] as const) {
      await prisma.cadDependency.create({
        data: {
          organizationId: org.id,
          parentDocumentId: created.root.id,
          childDocumentId: created[child].id,
          dependencyType: "COMPONENT",
          createdById: user.id,
        },
      });
    }

    // ---- verification ------------------------------------------------
    const plan = await getWorkspacePlanForActor(actor, created.root.id, prisma, provider);
    const planOk =
      plan.contract.id === "arch-plm.cad-workspace-plan" &&
      plan.contract.version === "1.0.0" &&
      plan.safe === true &&
      plan.entries.length === set.docs.length &&
      plan.entries.every((e) => e.canMaterialize && e.version !== null) &&
      plan.entries.find((e) => e.isRoot)?.cadDocumentId === created.root.id &&
      plan.entries.every((e) => e.version!.contentPath === `/api/file-versions/${e.version!.fileVersionId}/content`);

    let sourceMatchOk = true;
    let binaryOk = true;
    for (const spec of set.docs) {
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

    const baselineOk = (await baselineRowHash(prisma, set.prefix)) === baselineBefore;

    const line = (label: string, value: string) => { console.log(""); console.log(label); console.log(value); };
    console.log("");
    console.log(set === REAL_SET ? "REAL INVENTOR FIXTURE READY" : "MANUAL FIXTURE READY");
    line("Organization:", `${org.name} (${ORG_CODE})`);
    line("Root document number:", set.docs[0].documentNumber);
    line("Root cadDocumentId:", created.root.id);
    console.log("");
    console.log("Files:");
    for (const spec of set.docs) console.log(spec.fileName);
    line("Exact source byte match:", sourceMatchOk ? "PASS" : "FAIL");
    line("Workspace-plan package count:", String(plan.entries.length));
    line("Workspace-plan check:", planOk ? "PASS" : "FAIL");
    line("Binary retrieval check:", binaryOk ? "PASS" : "FAIL");
    line("Baseline preservation:", baselineOk ? "PASS" : "FAIL");
    line("Cleanup command:", set.cleanupCommand);

    if (!planOk || !binaryOk || !baselineOk || !sourceMatchOk) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("fixture failed:", error);
  process.exit(1);
});
