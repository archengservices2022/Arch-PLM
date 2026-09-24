/**
 * P6D ROUND 2 disposable integration gate — REAL PostgreSQL behavior for the
 * `(organizationId, documentNumber, documentType)` scoped uniqueness fix
 * (migration 20260921183016_scope_document_number_uniqueness_by_type) and
 * its two dependent code paths: Copy Design reservation
 * (`app/lib/copy-design-lineage-db.ts`) and the desktop resolve-by-number
 * endpoint (`app/lib/desktop-cad-documents-db.ts`).
 *
 * Not part of `npm test` (that suite uses in-memory fake DBs and cannot
 * prove real Postgres constraint behavior). Talks to the database directly
 * via a real `PrismaClient` - no HTTP layer, no running dev server needed.
 *
 * Run from the `web/` directory (after this migration has been applied -
 * `npx prisma migrate deploy`):
 *
 *   node --experimental-strip-types --env-file=.env scripts/itest-p6d-document-number-scoping.ts
 *
 * Proves, against a REAL PostgreSQL database:
 *   1. "1001.ipt" and "1001.idw" coexist as two separate CadDocument rows.
 *   2. "1001.iam" and "1001.dwg" coexist likewise.
 *   3. Two CadDocuments with the SAME documentNumber AND the SAME
 *      documentType are still rejected by the real unique index (P2002).
 *   4. The new constraint is tenant-scoped exactly like the old one -
 *      two DIFFERENT organizations may each independently use "1001.ipt".
 *   5. Ambiguous number-only resolution (via resolveCadDocumentForActor,
 *      against a REAL query) fails closed (409) when two documents share a
 *      number; typed resolution (documentNumber + documentType) returns the
 *      correct one.
 *   6. The existing single-document-per-number workflow (no type collision)
 *      still resolves exactly as before.
 *   7. A Copy Design reservation (`applyCopyDesignOperationForActor`)
 *      copying a model AND a drawing that share one destination
 *      documentNumber succeeds atomically - both CadDocuments are created
 *      in the SAME operation, with distinct ids.
 *
 * Throwaway `ITEST-<rand>` org(s)/user, direct PrismaClient, FK-safe cleanup
 * at the end. Never prints a password/token (this module needs neither).
 */
import { randomBytes } from "node:crypto";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  applyCopyDesignOperationForActor,
  type CopyDesignDb,
} from "../app/lib/copy-design-lineage-db.ts";
import {
  DesktopCadDocError,
  resolveCadDocumentForActor,
  type DesktopCadDocDb,
} from "../app/lib/desktop-cad-documents-db.ts";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function isPrismaErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const db = prisma as unknown as CopyDesignDb & DesktopCadDocDb;

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  const orgCodeB = `ITEST-${rand}-B`;
  console.log(`P6D ROUND 2 documentNumber-scoping real-Postgres gate — org ${orgCode}`);

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const org = await prisma.organization.create({ data: { name: `ITEST ${rand}`, code: orgCode } });
    const orgB = await prisma.organization.create({ data: { name: `ITEST ${rand} B`, code: orgCodeB } });
    const user = await prisma.user.create({
      data: { organizationId: org.id, email: `eng@${orgCode.toLowerCase()}.example`, name: "ITEST Engineer", role: UserRole.ENGINEER },
    });
    const userB = await prisma.user.create({
      data: { organizationId: orgB.id, email: `eng@${orgCodeB.toLowerCase()}.example`, name: "ITEST Engineer B", role: UserRole.ENGINEER },
    });
    const actor = { userId: user.id, organizationId: org.id, role: UserRole.ENGINEER, name: user.name, email: user.email };

    cleanup = async () => {
      await prisma.copyDesignOperationEntry.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.cadCopyLineage.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.copyDesignOperation.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.fileVersion.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.cadDocument.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.user.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, orgB.id] } } });
    };

    // ---- (1) 1001.ipt + 1001.idw coexist ---------------------------------
    const modelDoc = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: "1001", fileName: "1001.ipt", documentType: "IPT", createdById: user.id },
    });
    const drawingDoc = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: "1001", fileName: "1001.idw", documentType: "IDW", createdById: user.id },
    });
    check("(1) 1001.ipt and 1001.idw coexist as distinct CadDocument rows", modelDoc.id !== drawingDoc.id);

    // ---- (2) 1001.iam + 1001.dwg coexist ---------------------------------
    const assemblyDoc = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: "2002", fileName: "2002.iam", documentType: "IAM", createdById: user.id },
    });
    const dwgDoc = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: "2002", fileName: "2002.dwg", documentType: "DWG", createdById: user.id },
    });
    check("(2) 2002.iam and 2002.dwg coexist as distinct CadDocument rows", assemblyDoc.id !== dwgDoc.id);

    // ---- (3) duplicate SAME number + SAME type is still rejected ---------
    await assertRejectsWithCode(
      () =>
        prisma.cadDocument.create({
          data: { organizationId: org.id, documentNumber: "1001", fileName: "1001-dup.ipt", documentType: "IPT", createdById: user.id },
        }),
      "P2002",
      (ok, detail) => check("(3) duplicate (documentNumber, documentType) pair is rejected by the real unique index", ok, detail),
    );

    // ---- (4) cross-tenant unaffected - orgB may independently use "1001.ipt"
    const orgBDoc = await prisma.cadDocument.create({
      data: { organizationId: orgB.id, documentNumber: "1001", fileName: "1001.ipt", documentType: "IPT", createdById: userB.id },
    });
    check("(4) a DIFFERENT organization may independently use the SAME (documentNumber, documentType) pair", orgBDoc.id !== modelDoc.id);

    // ---- (5) ambiguous number-only resolution fails closed; typed resolves
    await assertThrowsStatus(
      () => resolveCadDocumentForActor(actor, { kind: "documentNumber", value: "1001", documentType: null }, db),
      409,
      (ok, detail) => check("(5a) ambiguous number-only resolveCadDocumentForActor fails closed (409)", ok, detail),
    );
    const typedIpt = await resolveCadDocumentForActor(actor, { kind: "documentNumber", value: "1001", documentType: "IPT" }, db);
    check("(5b) typed resolution (documentNumber + documentType=IPT) returns the correct document", typedIpt.cadDocumentId === modelDoc.id);
    const typedIdw = await resolveCadDocumentForActor(actor, { kind: "documentNumber", value: "1001", documentType: "IDW" }, db);
    check("(5c) typed resolution (documentNumber + documentType=IDW) returns the correct document", typedIdw.cadDocumentId === drawingDoc.id);

    // ---- (6) existing unique-number workflow still works ------------------
    const uniqueDoc = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: "3003-UNIQUE", fileName: "3003-UNIQUE.ipt", documentType: "IPT", createdById: user.id },
    });
    const uniqueResolved = await resolveCadDocumentForActor(actor, { kind: "documentNumber", value: "3003-UNIQUE", documentType: null }, db);
    check("(6) a genuinely unique documentNumber still resolves number-only, exactly as before", uniqueResolved.cadDocumentId === uniqueDoc.id);

    // ---- (7) Copy Design reservation of a matching model/drawing stem
    //          succeeds atomically ------------------------------------------
    const src = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SRC-MODEL`, fileName: "src.ipt", documentType: "IPT", createdById: user.id },
    });
    const srcFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: src.id, versionNumber: 1, originalFileName: "src.ipt", storageKey: `itest/${orgCode}/src-v1`, checksum: "deadbeef", fileSize: BigInt(1), createdById: user.id },
    });
    const srcDrawing = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SRC-DRAWING`, fileName: "src.idw", documentType: "IDW", createdById: user.id },
    });
    const srcDrawingFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: srcDrawing.id, versionNumber: 1, originalFileName: "src.idw", storageKey: `itest/${orgCode}/src-drawing-v1`, checksum: "cafebabe", fileSize: BigInt(1), createdById: user.id },
    });

    const copyResult = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-model-drawing-pair`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: "4004", newFileName: "4004.ipt", documentType: "IPT", description: null },
          { action: "COPY", sourceCadDocumentId: srcDrawing.id, sourceFileVersionId: srcDrawingFv.id, newDocumentNumber: "4004", newFileName: "4004.idw", documentType: "IDW", description: null },
        ],
      },
      db,
    );
    check(
      "(7a) Copy Design reservation of a matching model/drawing documentNumber stem succeeds atomically",
      copyResult.entries.length === 2,
    );
    check(
      "(7b) both reserved CadDocuments carry the SAME documentNumber but distinct ids",
      copyResult.entries[0]!.documentNumber === "4004" &&
        copyResult.entries[1]!.documentNumber === "4004" &&
        copyResult.entries[0]!.resultingCadDocumentId !== copyResult.entries[1]!.resultingCadDocumentId,
    );
    const persistedPair = await prisma.cadDocument.findMany({
      where: { organizationId: org.id, documentNumber: "4004" },
      select: { documentType: true },
    });
    check(
      "(7c) both CadDocument rows are actually persisted with distinct documentTypes",
      persistedPair.length === 2 && new Set(persistedPair.map((r) => r.documentType)).size === 2,
    );
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupError) {
        console.error("cleanup failed:", cleanupError);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function assertRejectsWithCode(
  fn: () => Promise<unknown>,
  code: string,
  report: (ok: boolean, detail?: string) => void,
): Promise<void> {
  try {
    await fn();
    report(false, "did not throw");
  } catch (error) {
    const ok = isPrismaErrorWithCode(error, code);
    report(ok, ok ? undefined : `got ${(error as { code?: string })?.code ?? String(error)}`);
  }
}

async function assertThrowsStatus(
  fn: () => Promise<unknown>,
  status: number,
  report: (ok: boolean, detail?: string) => void,
): Promise<void> {
  try {
    await fn();
    report(false, "did not throw");
  } catch (error) {
    const ok = error instanceof DesktopCadDocError && error.status === status;
    report(ok, ok ? undefined : `got ${String(error)}`);
  }
}

main().catch((error) => {
  console.error("integration gate crashed:", error);
  process.exit(1);
});
