/**
 * P6D ROUND 3 disposable integration gate — REAL PostgreSQL behavior for the
 * new authoritative Copy Design operation status lookup
 * (`app/lib/copy-design-operation-status-db.ts`, backing
 * `GET /api/desktop/copy-design/operations/:operationId/status`).
 *
 * Not part of `npm test` (that suite uses in-memory fake DBs and cannot
 * prove real Postgres query/constraint behavior). Talks to the database
 * directly via a real `PrismaClient` - no HTTP layer, no running dev server
 * needed.
 *
 * Run from the `web/` directory:
 *
 *   node --experimental-strip-types --env-file=.env scripts/itest-p6d-operation-status.ts
 *
 * Proves, against a REAL PostgreSQL database, that a status lookup built on
 * an ACTUAL `applyCopyDesignOperationForActor` reservation (real
 * CopyDesignOperation / CopyDesignOperationEntry / CadCopyLineage rows, not
 * a fake):
 *   1. a fresh COPY entry (zero FileVersion rows) is PENDING;
 *   2. a REUSE entry is REUSED immediately, with no FileVersion involved;
 *   3. once a real FileVersion 1 row exists for the COPY target, it becomes
 *      MATERIALIZED with the exact fileVersionId/sha256/fileSize;
 *   4. a SECOND FileVersion row for the same target (a malformed state this
 *      module should never produce on its own, but the status endpoint must
 *      never trust blindly) makes that entry INVALID, never MATERIALIZED;
 *   5. an unknown operationId is NotFound;
 *   6. an operationId that exists but belongs to a DIFFERENT organization is
 *      ALSO NotFound - never leaked as existing.
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
  loadCopyDesignOperationStatus,
  CopyDesignOperationStatusNotFoundError,
  type CopyDesignOperationStatusDb,
} from "../app/lib/copy-design-operation-status-db.ts";

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

async function assertThrows(fn: () => Promise<unknown>, errorCtor: new (...args: never[]) => Error): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof errorCtor;
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const db = prisma as unknown as CopyDesignDb & CopyDesignOperationStatusDb;

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  const orgCodeB = `ITEST-${rand}-B`;
  console.log(`P6D ROUND 3 operation-status real-Postgres gate — org ${orgCode}`);

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const org = await prisma.organization.create({ data: { name: `ITEST ${rand}`, code: orgCode } });
    const orgB = await prisma.organization.create({ data: { name: `ITEST ${rand} B`, code: orgCodeB } });
    const user = await prisma.user.create({
      data: { organizationId: org.id, email: `eng@${orgCode.toLowerCase()}.example`, name: "ITEST Engineer", role: UserRole.ENGINEER },
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

    // ---- set up: a COPY source and a REUSE target -------------------------
    const src = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SRC`, fileName: "src.ipt", documentType: "IPT", createdById: user.id },
    });
    const srcFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: src.id, versionNumber: 1, originalFileName: "src.ipt", storageKey: `itest/${orgCode}/src-v1`, checksum: "deadbeef", fileSize: BigInt(1), createdById: user.id },
    });
    const reuseTarget = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-REUSE`, fileName: "std-bolt.ipt", documentType: "IPT", createdById: user.id },
    });

    const reservation = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-op-status`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: "5005", newFileName: "5005.ipt", documentType: "IPT", description: null },
          { action: "REUSE", cadDocumentId: reuseTarget.id },
        ],
      },
      db,
    );
    const operationId = reservation.copyDesignOperationId;
    const copyEntry = reservation.entries.find((e) => e.action === "COPY")!;
    const resultingCadDocumentId = copyEntry.resultingCadDocumentId;

    // ---- (1) fresh COPY entry is PENDING -----------------------------------
    const status1 = await loadCopyDesignOperationStatus(db, org.id, operationId);
    const copyStatus1 = status1.entries.find((e) => e.resultingCadDocumentId === resultingCadDocumentId);
    check("(1) a fresh COPY entry (zero FileVersion rows) is PENDING", copyStatus1?.state === "PENDING");

    // ---- (2) REUSE entry is REUSED immediately -----------------------------
    const reuseStatus = status1.entries.find((e) => e.resultingCadDocumentId === reuseTarget.id);
    check("(2) a REUSE entry is REUSED immediately, no FileVersion involved", reuseStatus?.state === "REUSED" && reuseStatus.action === "REUSE");

    // ---- (3) a real FileVersion 1 makes it MATERIALIZED --------------------
    const canonSha = "a".repeat(64);
    const fv1 = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: resultingCadDocumentId, versionNumber: 1, originalFileName: "5005.ipt", storageKey: `itest/${orgCode}/5005-v1`, checksum: canonSha, fileSize: BigInt(2048), createdById: user.id },
    });
    const status2 = await loadCopyDesignOperationStatus(db, org.id, operationId);
    const copyStatus2 = status2.entries.find((e) => e.resultingCadDocumentId === resultingCadDocumentId);
    check(
      "(3) once a real FileVersion 1 exists, the entry is MATERIALIZED with the exact identity",
      copyStatus2?.state === "MATERIALIZED"
        && (copyStatus2 as { fileVersionId?: string }).fileVersionId === fv1.id
        && (copyStatus2 as { sha256?: string }).sha256 === canonSha
        && (copyStatus2 as { fileSize?: number }).fileSize === 2048,
    );

    // ---- (4) a SECOND FileVersion row makes it INVALID, never MATERIALIZED -
    await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: resultingCadDocumentId, versionNumber: 2, originalFileName: "5005.ipt", storageKey: `itest/${orgCode}/5005-v2`, checksum: "b".repeat(64), fileSize: BigInt(4096), createdById: user.id },
    });
    const status3 = await loadCopyDesignOperationStatus(db, org.id, operationId);
    const copyStatus3 = status3.entries.find((e) => e.resultingCadDocumentId === resultingCadDocumentId);
    check("(4) a second FileVersion row makes the entry INVALID, never MATERIALIZED", copyStatus3?.state === "INVALID");

    // ---- (5) unknown operationId is NotFound -------------------------------
    check(
      "(5) an unknown operationId is NotFound",
      await assertThrows(() => loadCopyDesignOperationStatus(db, org.id, "op-does-not-exist"), CopyDesignOperationStatusNotFoundError),
    );

    // ---- (6) cross-tenant operationId is ALSO NotFound - never leaked ------
    check(
      "(6) an operationId that exists but in a DIFFERENT organization is NotFound, never leaked",
      await assertThrows(() => loadCopyDesignOperationStatus(db, orgB.id, operationId), CopyDesignOperationStatusNotFoundError),
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
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
