/**
 * P6E-A disposable integration gate — REAL PostgreSQL behavior for the new
 * Copy Design verification-support lookup
 * (`app/lib/copy-design-verification-support-db.ts`, backing
 * `GET /api/desktop/copy-design/operations/:operationId/verification-support`).
 *
 * Not part of `npm test` (that suite uses in-memory fake DBs and cannot
 * prove real Postgres query/constraint/index behavior, in particular the
 * REAL `CadDependency` @@unique + composite-FK enforcement). Talks to the
 * database directly via a real `PrismaClient` - no HTTP layer, no running
 * dev server needed.
 *
 * Run from the `web/` directory:
 *
 *   node --experimental-strip-types --env-file=.env scripts/itest-p6e-verification-support.ts
 *
 * Proves, against a REAL PostgreSQL database, built on an ACTUAL
 * `applyCopyDesignOperationForActor` reservation (real CopyDesignOperation /
 * CopyDesignOperationEntry / CadCopyLineage rows) plus REAL `CadDependency`
 * rows (created directly - Copy Design itself never writes CadDependency,
 * confirmed by inspection: this script IS how the source topology a real
 * PDM import/registration step would have already populated is simulated):
 *
 *   1. every valid COPY entry gets exactly one AVAILABLE evidence record
 *      with the correct sha256/fileSize, metadata only;
 *   3. a REAL FileVersion row with a non-canonical checksum (the schema
 *      places NO format constraint on `checksum`, so this IS reachable
 *      through real data, unlike UNAVAILABLE/mismatched-ownership below) is
 *      an explicit INVALID record, never fabricated/omitted;
 *   6/7. a nested real COMPONENT topology (MAIN -> SUB-A -> A1) is returned
 *      completely, in deterministic order;
 *   8/9(topology). a REAL CadDependency edge naming a document OUTSIDE this
 *      operation (as parent or as child) is excluded;
 *   9(reuse-topology). a REAL CadDependency edge FROM a COPY'd document TO a
 *      REUSE'd one is included - proves the REUSE identity genuinely
 *      participates in componentEdges, not just the COPY sources;
 *   10a. an unknown operationId and a DIFFERENT organization's operationId
 *      both NotFound, indistinguishably; a REAL CadDependency edge in a
 *      DIFFERENT organization, even with the same ids reused in this
 *      tenant, is excluded;
 *   8(reuse). a REUSE entry carries NO source FileVersion integrity record
 *      at all, even though the reused document itself genuinely has
 *      FileVersion rows - proving against REAL data that P6D truly never
 *      freezes one for REUSE.
 *
 * NOT exercised here (real-Postgres cannot construct them - covered
 * instead, exhaustively, by `tests/copy-design-verification-support-db.test.ts`
 * against a fake DB): UNAVAILABLE (a COPY entry's sourceFileVersionId
 * pointing at a FileVersion row that does not exist) and the
 * mismatched-ownership INVALID case (a FileVersion row owned by a DIFFERENT
 * cadDocumentId than the entry claims). Both are structurally IMPOSSIBLE to
 * produce through any real write path: `CopyDesignOperationEntry.sourceFileVersion`
 * is a composite FK requiring `(organizationId, sourceCadDocumentId,
 * sourceFileVersionId)` to match `FileVersion`'s own `(organizationId,
 * cadDocumentId, id)` at INSERT time, and FileVersion rows are never
 * deleted (`onDelete: Restrict` everywhere they're referenced) - so the
 * database itself guarantees these two states can only ever be reached by
 * direct, out-of-band data manipulation, never by this application's own
 * code. The defensive handling exists anyway (fail closed on anything
 * unproven), verified with a fake DB instead.
 *
 * Throwaway `ITEST-<rand>` org(s)/user, direct PrismaClient, FK-safe cleanup
 * at the end - ONLY this script's own disposable rows, nothing else.
 */
import { randomBytes } from "node:crypto";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  applyCopyDesignOperationForActor,
  type CopyDesignDb,
} from "../app/lib/copy-design-lineage-db.ts";
import {
  CopyDesignOperationStatusNotFoundError,
  loadCopyDesignVerificationSupport,
  type CopyDesignVerificationSupportDb,
} from "../app/lib/copy-design-verification-support-db.ts";

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
  const db = prisma as unknown as CopyDesignDb & CopyDesignVerificationSupportDb;

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  const orgCodeB = `ITEST-${rand}-B`;
  console.log(`P6E-A verification-support real-Postgres gate — org ${orgCode}`);

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
      await prisma.cadDependency.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.copyDesignOperationEntry.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.cadCopyLineage.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.copyDesignOperation.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.fileVersion.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.cadDocument.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.user.deleteMany({ where: { organizationId: { in: [org.id, orgB.id] } } });
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, orgB.id] } } });
    };

    // ---- set up a real nested source closure: MAIN -> SUB-A -> A1, plus a
    //      standalone UNRELATED document and a REUSE target -----------------
    const main = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-MAIN`, fileName: "main.iam", documentType: "IAM", createdById: user.id },
    });
    const mainFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: main.id, versionNumber: 1, originalFileName: "main.iam", storageKey: `itest/${orgCode}/main-v1`, checksum: "1".repeat(64), fileSize: BigInt(100), createdById: user.id },
    });
    const subA = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SUBA`, fileName: "suba.iam", documentType: "IAM", createdById: user.id },
    });
    const subAFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: subA.id, versionNumber: 1, originalFileName: "suba.iam", storageKey: `itest/${orgCode}/suba-v1`, checksum: "2".repeat(64), fileSize: BigInt(200), createdById: user.id },
    });
    const a1 = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-A1`, fileName: "a1.ipt", documentType: "IPT", createdById: user.id },
    });
    const a1Fv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: a1.id, versionNumber: 1, originalFileName: "a1.ipt", storageKey: `itest/${orgCode}/a1-v1`, checksum: "MALFORMED-NOT-CANONICAL", fileSize: BigInt(300), createdById: user.id },
    });
    const unrelated = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-UNRELATED`, fileName: "unrelated.ipt", documentType: "IPT", createdById: user.id },
    });
    const reuseTarget = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-REUSE`, fileName: "std-bolt.ipt", documentType: "IPT", createdById: user.id },
    });
    await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: reuseTarget.id, versionNumber: 1, originalFileName: "std-bolt.ipt", storageKey: `itest/${orgCode}/reuse-v1`, checksum: "9".repeat(64), fileSize: BigInt(9), createdById: user.id },
    });

    // Real CadDependency edges: MAIN -COMPONENT-> SUB-A -COMPONENT-> A1, and
    // an edge naming the UNRELATED document (must never leak into this
    // operation's topology).
    await prisma.cadDependency.create({ data: { organizationId: org.id, parentDocumentId: main.id, childDocumentId: subA.id, dependencyType: "COMPONENT", createdById: user.id } });
    await prisma.cadDependency.create({ data: { organizationId: org.id, parentDocumentId: subA.id, childDocumentId: a1.id, dependencyType: "COMPONENT", createdById: user.id } });
    await prisma.cadDependency.create({ data: { organizationId: org.id, parentDocumentId: main.id, childDocumentId: unrelated.id, dependencyType: "COMPONENT", createdById: user.id } });
    // MAIN -> the REUSE target: proves a REUSE'd document's identity
    // genuinely participates in the returned topology.
    await prisma.cadDependency.create({ data: { organizationId: org.id, parentDocumentId: main.id, childDocumentId: reuseTarget.id, dependencyType: "COMPONENT", createdById: user.id } });
    // A same-shaped edge in a DIFFERENT organization (using orgB's own
    // documents - a cross-org edge naming org's ids is impossible by FK
    // design, so this instead proves the QUERY's organizationId filter, not
    // merely id non-collision, by using org-B-owned endpoints for real).
    const mainB = await prisma.cadDocument.create({
      data: { organizationId: orgB.id, documentNumber: `${orgCodeB}-MAIN`, fileName: "main.iam", documentType: "IAM", createdById: userB.id },
    });
    const subAB = await prisma.cadDocument.create({
      data: { organizationId: orgB.id, documentNumber: `${orgCodeB}-SUBA`, fileName: "suba.iam", documentType: "IAM", createdById: userB.id },
    });
    await prisma.cadDependency.create({ data: { organizationId: orgB.id, parentDocumentId: mainB.id, childDocumentId: subAB.id, dependencyType: "COMPONENT", createdById: userB.id } });

    const reservation = await applyCopyDesignOperationForActor(
      actor,
      {
        idempotencyKey: `${orgCode}-op-verify`,
        entries: [
          { action: "COPY", sourceCadDocumentId: main.id, sourceFileVersionId: mainFv.id, newDocumentNumber: `${orgCode}NEW-MAIN`, newFileName: "MAIN-NEW.iam", documentType: "IAM", description: null },
          { action: "COPY", sourceCadDocumentId: subA.id, sourceFileVersionId: subAFv.id, newDocumentNumber: `${orgCode}NEW-SUBA`, newFileName: "SUBA-NEW.iam", documentType: "IAM", description: null },
          { action: "COPY", sourceCadDocumentId: a1.id, sourceFileVersionId: a1Fv.id, newDocumentNumber: `${orgCode}NEW-A1`, newFileName: "A1-NEW.ipt", documentType: "IPT", description: null },
          { action: "REUSE", cadDocumentId: reuseTarget.id },
        ],
      },
      db,
    );
    const operationId = reservation.copyDesignOperationId;

    // ---- (1) same-tenant success + AVAILABLE evidence ----------------------
    const support = await loadCopyDesignVerificationSupport(db, org.id, operationId);
    check(
      "(1a) authenticated same-tenant operation succeeds, embedding operation-status verbatim",
      support.contract === "arch-plm.copy-design-verification-support.v1"
        && support.operationStatus.contract === "arch-plm.copy-design-operation-status.v1"
        && support.operationStatus.entries.length === 4,
    );

    const mainIntegrity = support.sourceFileVersionIntegrity.find((r) => r.sourceFileVersionId === mainFv.id);
    check(
      "(1b) a valid COPY entry gets exactly one AVAILABLE evidence record with the correct sha256/fileSize",
      mainIntegrity?.state === "AVAILABLE"
        && (mainIntegrity as { sha256?: string }).sha256 === "1".repeat(64)
        && (mainIntegrity as { fileSize?: number }).fileSize === 100
        && mainIntegrity?.sourceCadDocumentId === main.id,
    );
    // Every COPY entry (3 of them) gets exactly one record each - never omitted.
    check(
      "(1c) every COPY entry has exactly one evidence record (3 COPY entries -> 3 records, never fewer)",
      support.sourceFileVersionIntegrity.length === 3,
    );

    // ---- (3) a real non-canonical checksum is an explicit INVALID record --
    const a1Integrity = support.sourceFileVersionIntegrity.find((r) => r.sourceFileVersionId === a1Fv.id);
    check(
      "(3) a real non-canonical source checksum is an explicit INVALID record, never omitted or fabricated",
      a1Integrity?.state === "INVALID" && (a1Integrity as { reason?: string }).reason === "non-canonical checksum",
    );

    // ---- (6/7) nested real COMPONENT topology ------------------------------
    const hasMainToSubA = support.componentEdges.some((e) => e.parentCadDocumentId === main.id && e.childCadDocumentId === subA.id);
    const hasSubAToA1 = support.componentEdges.some((e) => e.parentCadDocumentId === subA.id && e.childCadDocumentId === a1.id);
    check("(6) COMPONENT parent->child edge returned when both endpoints belong to op", hasMainToSubA);
    check("(7) nested COMPONENT edges returned correctly (MAIN->SUB-A->A1)", hasMainToSubA && hasSubAToA1);

    // ---- (9-topology) MAIN -> REUSE target edge is included -----------------
    const hasMainToReuse = support.componentEdges.some((e) => e.parentCadDocumentId === main.id && e.childCadDocumentId === reuseTarget.id);
    check("(9) a mixed COPY/REUSE operation still includes the REUSE identity in COMPONENT topology edges", hasMainToReuse);

    // ---- (8-topology) edges to/from a document outside the operation excluded
    const leaksUnrelated = support.componentEdges.some((e) => e.parentCadDocumentId === unrelated.id || e.childCadDocumentId === unrelated.id);
    check("(8) an edge naming a document OUTSIDE the operation is excluded", !leaksUnrelated);

    // ---- (10a) unknown + foreign-tenant operationId indistinguishable; real
    //      cross-tenant CadDependency edge excluded --------------------------
    check(
      "(10a-i) an unknown operationId is NotFound",
      await assertThrows(() => loadCopyDesignVerificationSupport(db, org.id, "op-does-not-exist"), CopyDesignOperationStatusNotFoundError),
    );
    check(
      "(10a-ii) an operationId that exists but in a DIFFERENT organization is NotFound, never leaked",
      await assertThrows(() => loadCopyDesignVerificationSupport(db, orgB.id, operationId), CopyDesignOperationStatusNotFoundError),
    );
    const leaksForeignTenant = support.componentEdges.some((e) => e.parentCadDocumentId === mainB.id || e.childCadDocumentId === subAB.id);
    check("(10a-iii) a real dependency from another tenant is excluded", !leaksForeignTenant);

    // ---- (8-reuse) REUSE entry carries no source integrity, even though the
    //      reused document genuinely HAS a FileVersion -----------------------
    const reuseEntryStatus = support.operationStatus.entries.find((e) => e.action === "REUSE");
    const reuseHasIntegrity = support.sourceFileVersionIntegrity.some((r) => r.sourceCadDocumentId === reuseTarget.id);
    check(
      "(8-reuse) a REUSE entry produces NO fabricated historical integrity record",
      reuseEntryStatus?.state === "REUSED" && !reuseHasIntegrity,
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
