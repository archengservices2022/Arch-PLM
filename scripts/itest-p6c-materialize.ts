/**
 * P6C disposable integration gate — REAL PostgreSQL behavior for
 * materializing the first FileVersion of a P6B-reserved Copy Design target
 * (`app/lib/copy-design-materialize-db.ts`).
 *
 * Not part of `npm test` (that suite uses an in-memory fake DB and cannot
 * prove real Postgres row-lock/transaction/concurrency behavior). Does NOT
 * need a running dev server - both `applyCopyDesignOperationForActor` (P6B)
 * and `materializeFirstFileVersionForActor` (P6C) are directly callable with
 * a real `PrismaClient`, so this script talks to the database directly.
 *
 * Run from the `web/` directory:
 *
 *   node --experimental-strip-types --env-file=.env scripts/itest-p6c-materialize.ts
 *
 * Proves, against a REAL PostgreSQL database:
 *   1. a genuinely P6B-reserved target (real CadCopyLineage row, zero
 *      FileVersions, created via the real `applyCopyDesignOperationForActor`)
 *      can be materialized to FileVersion 1;
 *   2. after materialization, exactly ONE FileVersion row exists for that
 *      CadDocument, with versionNumber 1 and hash/size matching the upload;
 *   3. the source CadDocument and source FileVersion are byte-for-byte
 *      unchanged, and the CadCopyLineage row is unchanged;
 *   4. two CONCURRENT materialize requests for the SAME reserved target
 *      (identical content) against REAL SERIALIZABLE transactions produce
 *      exactly ONE FileVersion row - never two, never a version 2;
 *   5. a real unique-constraint-backed re-verification: querying the
 *      database directly (not through the module) confirms the target went
 *      from zero FileVersions to exactly one;
 *   6. (Round 2, HIGH 2) against REAL Postgres + real local storage: once a
 *      target's stored object is deleted out-of-band (simulating loss/
 *      corruption), a retry NEVER reports idempotent replay success - it
 *      fails with a controlled integrity error, and the (still-present, now
 *      orphaned) FileVersion row is left untouched;
 *   7. (Round 2, MEDIUM 1) against REAL Postgres: a target whose FileVersion
 *      state is malformed (an out-of-band version 2 row with no version 1)
 *      is rejected as an invalid state - never a create, never a replay;
 *   8. (Round 2, HIGH 1) against REAL Postgres: the GENERIC upload path
 *      (`storeCadFileVersionForActor`) refuses to create version 1 for a
 *      reserved zero-version Copy Design target, and remains completely
 *      unaffected for an ordinary CadDocument.
 *
 * Throwaway `ITEST-<rand>` org/users, a throwaway local storage directory,
 * direct PrismaClient, FK-safe cleanup at the end.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import { applyCopyDesignOperationForActor, type CopyDesignDb } from "../app/lib/copy-design-lineage-db.ts";
import { LocalFilesystemStorage, sha256Hex } from "../app/lib/storage-core.ts";
import {
  CopyDesignAlreadyMaterializedError,
  CopyDesignMaterializeIntegrityError,
  CopyDesignMaterializeInvalidStateError,
  materializeFirstFileVersionForActor,
  type CopyDesignMaterializeDb,
} from "../app/lib/copy-design-materialize-db.ts";
import type { CopyDesignMaterializeRequestMeta } from "../app/lib/copy-design-materialize-core.ts";
import { ReservedCopyDesignTargetError, storeCadFileVersionForActor, type UploadGuardDb } from "../app/lib/upload-guard-db.ts";

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

function bytesSource(content: Buffer): Readable {
  return Readable.from([content]);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const db = prisma as unknown as CopyDesignDb & CopyDesignMaterializeDb;

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  console.log(`P6C materialize real-Postgres gate — org ${orgCode}`);

  const storageDir = await mkdtemp(path.join(tmpdir(), "pdm-itest-p6c-"));
  const provider = new LocalFilesystemStorage(storageDir);

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const org = await prisma.organization.create({ data: { name: `ITEST ${rand}`, code: orgCode } });
    const user = await prisma.user.create({
      data: { organizationId: org.id, email: `eng@${orgCode.toLowerCase()}.example`, name: "ITEST Engineer", role: UserRole.ENGINEER },
    });
    const actor = { userId: user.id, organizationId: org.id, role: UserRole.ENGINEER, name: user.name, email: user.email };

    const src = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SRC`, fileName: "src.ipt", documentType: "IPT", createdById: user.id },
    });
    const srcFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: src.id, versionNumber: 1, originalFileName: "src.ipt", storageKey: `itest/${orgCode}/src-v1`, checksum: "deadbeef", fileSize: BigInt(1), createdById: user.id },
    });

    cleanup = async () => {
      await prisma.copyDesignOperationEntry.deleteMany({ where: { organizationId: org.id } });
      await prisma.cadCopyLineage.deleteMany({ where: { organizationId: org.id } });
      await prisma.copyDesignOperation.deleteMany({ where: { organizationId: org.id } });
      await prisma.fileVersion.deleteMany({ where: { organizationId: org.id } });
      await prisma.cadDocument.deleteMany({ where: { organizationId: org.id } });
      await prisma.user.deleteMany({ where: { organizationId: org.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } });
      await rm(storageDir, { recursive: true, force: true });
    };

    // ---- (1) create a REAL P6B reservation to materialize -----------------
    const reservation = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-reserve-1`,
        entries: [
          {
            action: "COPY",
            sourceCadDocumentId: src.id,
            sourceFileVersionId: srcFv.id,
            newDocumentNumber: `${orgCode}-NEW1`,
            newFileName: "new1.ipt",
            documentType: "IPT",
          },
        ],
      },
      db,
    );
    const copyDesignOperationId = reservation.copyDesignOperationId;
    const resultingCadDocumentId = reservation.entries[0].resultingCadDocumentId;
    check("(1) P6B reservation created a real reserved target", !!resultingCadDocumentId && !!copyDesignOperationId);

    const zeroVersionsBefore = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: resultingCadDocumentId } });
    check("(1) reserved target starts with ZERO FileVersions", zeroVersionsBefore === 0, `got ${zeroVersionsBefore}`);

    const content = Buffer.from(`ITEST P6C materialize content ${rand}`);
    const meta = (overrides: Partial<CopyDesignMaterializeRequestMeta> = {}): CopyDesignMaterializeRequestMeta => ({
      copyDesignOperationId,
      cadDocumentId: resultingCadDocumentId,
      sourceCadDocumentId: src.id,
      documentType: "IPT",
      originalFileName: "new1.ipt",
      expectedSha256: sha256Hex(content),
      expectedFileSize: content.length,
      ...overrides,
    });

    // ---- (2) happy path materialize ----------------------------------------
    const result = await materializeFirstFileVersionForActor(actor, meta(), bytesSource(content), 10_000_000, db, provider);
    check("(2) materialize creates FileVersion 1", result.versionNumber === 1 && !result.idempotentReplay);
    check("(2) resulting cadDocumentId matches the reserved target", result.cadDocumentId === resultingCadDocumentId);

    const afterCount = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: resultingCadDocumentId } });
    check("(5) exactly ONE FileVersion exists for the target after materialization", afterCount === 1, `got ${afterCount}`);

    const versionRow = await prisma.fileVersion.findFirst({ where: { organizationId: org.id, cadDocumentId: resultingCadDocumentId } });
    check("(2) stored checksum/size match the uploaded bytes", versionRow?.checksum === sha256Hex(content) && Number(versionRow?.fileSize) === content.length);

    // ---- (3) source + lineage unchanged -------------------------------------
    const srcAfter = await prisma.cadDocument.findUniqueOrThrow({ where: { id: src.id } });
    const srcFvAfter = await prisma.fileVersion.findUniqueOrThrow({ where: { id: srcFv.id } });
    const lineageAfter = await prisma.cadCopyLineage.findFirst({ where: { organizationId: org.id, newCadDocumentId: resultingCadDocumentId } });
    check("(3) source CadDocument unchanged", srcAfter.fileName === "src.ipt" && srcAfter.documentType === "IPT");
    check("(3) source FileVersion unchanged", srcFvAfter.checksum === "deadbeef" && Number(srcFvAfter.fileSize) === 1);
    check("(3) CadCopyLineage row unchanged", lineageAfter?.sourceCadDocumentId === src.id && lineageAfter?.newCadDocumentId === resultingCadDocumentId);
    const srcVersionCount = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: src.id } });
    check("(3) no new FileVersion was ever created for the SOURCE document", srcVersionCount === 1, `got ${srcVersionCount}`);

    // ---- (4) concurrent materialize on a SECOND fresh reserved target -----
    const reservation2 = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-reserve-2`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: `${orgCode}-NEW2`, newFileName: "new2.ipt", documentType: "IPT" },
        ],
      },
      db,
    );
    const target2 = reservation2.entries[0].resultingCadDocumentId;
    const content2 = Buffer.from(`ITEST P6C concurrent content ${rand}`);
    const meta2 = (): CopyDesignMaterializeRequestMeta => ({
      copyDesignOperationId: reservation2.copyDesignOperationId,
      cadDocumentId: target2,
      sourceCadDocumentId: src.id,
      documentType: "IPT",
      originalFileName: "new2.ipt",
      expectedSha256: sha256Hex(content2),
      expectedFileSize: content2.length,
    });

    const concurrentResults = await Promise.allSettled([
      materializeFirstFileVersionForActor(actor, meta2(), bytesSource(content2), 10_000_000, db, provider),
      materializeFirstFileVersionForActor(actor, meta2(), bytesSource(content2), 10_000_000, db, provider),
    ]);
    const fulfilled = concurrentResults.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof materializeFirstFileVersionForActor>>
    >[];
    check("(4) both concurrent identical-content requests resolved successfully", fulfilled.length === 2, JSON.stringify(concurrentResults.map((r) => r.status)));
    if (fulfilled.length === 2) {
      check("(4) both concurrent requests returned the SAME FileVersion id", fulfilled[0]!.value.fileVersionId === fulfilled[1]!.value.fileVersionId);
    }
    const target2Count = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: target2 } });
    check("(4) exactly ONE FileVersion row exists for the concurrently-materialized target", target2Count === 1, `got ${target2Count}`);
    const target2Versions = await prisma.fileVersion.findMany({ where: { organizationId: org.id, cadDocumentId: target2 }, select: { versionNumber: true } });
    check("(4) never a version 2", target2Versions.every((v) => v.versionNumber === 1));

    // ---- concurrent DIFFERENT content -> loser conflicts, no version 2 ----
    const reservation3 = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-reserve-3`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: `${orgCode}-NEW3`, newFileName: "new3.ipt", documentType: "IPT" },
        ],
      },
      db,
    );
    const target3 = reservation3.entries[0].resultingCadDocumentId;
    const contentA = Buffer.from(`ITEST P6C content A ${rand}`);
    const contentB = Buffer.from(`ITEST P6C content B, materially different ${rand}`);
    const metaFor3 = (c: Buffer): CopyDesignMaterializeRequestMeta => ({
      copyDesignOperationId: reservation3.copyDesignOperationId,
      cadDocumentId: target3,
      sourceCadDocumentId: src.id,
      documentType: "IPT",
      originalFileName: "new3.ipt",
      expectedSha256: sha256Hex(c),
      expectedFileSize: c.length,
    });
    const raceResults = await Promise.allSettled([
      materializeFirstFileVersionForActor(actor, metaFor3(contentA), bytesSource(contentA), 10_000_000, db, provider),
      materializeFirstFileVersionForActor(actor, metaFor3(contentB), bytesSource(contentB), 10_000_000, db, provider),
    ]);
    const raceFulfilled = raceResults.filter((r) => r.status === "fulfilled");
    const raceRejected = raceResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    check("concurrent DIFFERENT content: exactly one succeeds", raceFulfilled.length === 1, JSON.stringify(raceResults.map((r) => r.status)));
    check(
      "concurrent DIFFERENT content: the loser gets a controlled conflict, never an unhandled error",
      raceRejected.length === 1 && raceRejected[0]!.reason instanceof CopyDesignAlreadyMaterializedError,
    );
    const target3Count = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: target3 } });
    check("concurrent DIFFERENT content: exactly ONE FileVersion row exists", target3Count === 1, `got ${target3Count}`);

    // ---- (6) Round 2, HIGH 2: stored-object integrity against REAL Postgres + REAL storage ----
    const reservation4 = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-reserve-4`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: `${orgCode}-NEW4`, newFileName: "new4.ipt", documentType: "IPT" },
        ],
      },
      db,
    );
    const target4 = reservation4.entries[0].resultingCadDocumentId;
    const content4 = Buffer.from(`ITEST P6C integrity content ${rand}`);
    const meta4 = (): CopyDesignMaterializeRequestMeta => ({
      copyDesignOperationId: reservation4.copyDesignOperationId,
      cadDocumentId: target4,
      sourceCadDocumentId: src.id,
      documentType: "IPT",
      originalFileName: "new4.ipt",
      expectedSha256: sha256Hex(content4),
      expectedFileSize: content4.length,
    });
    const materialized4 = await materializeFirstFileVersionForActor(actor, meta4(), bytesSource(content4), 10_000_000, db, provider);
    check("(6) target4 materialized normally first", materialized4.versionNumber === 1 && !materialized4.idempotentReplay);

    const row4 = await prisma.fileVersion.findFirstOrThrow({ where: { organizationId: org.id, cadDocumentId: target4 } });
    await rm(path.join(storageDir, row4.storageKey), { force: true }); // simulate real-world loss/corruption out-of-band
    let sawIntegrityError = false;
    try {
      await materializeFirstFileVersionForActor(actor, meta4(), bytesSource(content4), 10_000_000, db, provider);
    } catch (error) {
      sawIntegrityError = error instanceof CopyDesignMaterializeIntegrityError;
    }
    check("(6) retry after real storage loss fails with a controlled integrity error, never reports replay success", sawIntegrityError);
    const target4CountAfter = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: target4 } });
    check("(6) the existing (now-orphaned) FileVersion row is left untouched - no second row, no deletion", target4CountAfter === 1, `got ${target4CountAfter}`);

    // ---- (7) Round 2, MEDIUM 1: malformed FileVersion state against REAL Postgres ----
    const reservation5 = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-reserve-5`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: `${orgCode}-NEW5`, newFileName: "new5.ipt", documentType: "IPT" },
        ],
      },
      db,
    );
    const target5 = reservation5.entries[0].resultingCadDocumentId;
    // Directly insert an out-of-band version 2 row (bypassing the module
    // entirely) - a malformed state no legitimate path produces.
    await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: target5, versionNumber: 2, originalFileName: "malformed.ipt", storageKey: `itest/${orgCode}/malformed-v2`, checksum: "malformed", fileSize: BigInt(1), createdById: user.id },
    });
    const content5 = Buffer.from(`ITEST P6C malformed-state content ${rand}`);
    let sawInvalidState = false;
    try {
      await materializeFirstFileVersionForActor(
        actor,
        { copyDesignOperationId: reservation5.copyDesignOperationId, cadDocumentId: target5, sourceCadDocumentId: src.id, documentType: "IPT", originalFileName: "new5.ipt", expectedSha256: sha256Hex(content5), expectedFileSize: content5.length },
        bytesSource(content5), 10_000_000, db, provider,
      );
    } catch (error) {
      sawInvalidState = error instanceof CopyDesignMaterializeInvalidStateError;
    }
    check("(7) a target with only a version 2 row (malformed state) is rejected against REAL Postgres", sawInvalidState);

    // ---- (8) Round 2, HIGH 1: generic upload guard against REAL Postgres ----
    const reservation6 = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-reserve-6`,
        entries: [
          { action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, newDocumentNumber: `${orgCode}-NEW6`, newFileName: "new6.ipt", documentType: "IPT" },
        ],
      },
      db,
    );
    const target6 = reservation6.entries[0].resultingCadDocumentId;
    let sawReservedGuard = false;
    try {
      await storeCadFileVersionForActor(actor, target6, bytesSource(Buffer.from("generic upload attempt")), null, 10_000_000, db as unknown as UploadGuardDb, provider);
    } catch (error) {
      sawReservedGuard = error instanceof ReservedCopyDesignTargetError;
    }
    check("(8) generic upload refuses to create version 1 for a reserved target against REAL Postgres", sawReservedGuard);
    const target6Count = await prisma.fileVersion.count({ where: { organizationId: org.id, cadDocumentId: target6 } });
    check("(8) no FileVersion was created by the refused generic upload", target6Count === 0, `got ${target6Count}`);

    const ordinaryDoc = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-ORDINARY`, fileName: "ordinary.ipt", documentType: "IPT", createdById: user.id },
    });
    const ordinaryResult = await storeCadFileVersionForActor(actor, ordinaryDoc.id, bytesSource(Buffer.from("ordinary generic upload")), null, 10_000_000, db as unknown as UploadGuardDb, provider);
    check("(8) an ORDINARY (non-reserved) CadDocument is completely unaffected by the guard", ordinaryResult.versionNumber === 1);
  } finally {
    if (cleanup) {
      try {
        await cleanup();
        console.log("  ok   ITEST rows + storage dir cleaned up");
      } catch (error) {
        failed++;
        console.log(`  FAIL cleanup — ${(error as Error).message}`);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("integration gate crashed:", error);
  process.exit(1);
});
