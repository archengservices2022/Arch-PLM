/**
 * P6B disposable integration gate — REAL PostgreSQL behavior for Copy Design
 * identity reservation + lineage (`app/lib/copy-design-lineage-db.ts`).
 *
 * Not part of `npm test` (that suite uses an in-memory fake DB and cannot
 * prove real Postgres constraint/transaction/concurrency behavior). Unlike
 * `itest-p4c-checkout.ts`, this does NOT need a running dev server -
 * `applyCopyDesignOperationForActor` is directly callable with a real
 * `PrismaClient` passed as its `db` parameter, so this script talks to the
 * database directly, with no HTTP layer at all.
 *
 * Run from the `web/` directory (after the P6B migrations have been
 * applied - `npx prisma migrate dev` / `deploy`):
 *
 *   node --experimental-strip-types --env-file=.env scripts/itest-p6b-copy-design.ts
 *
 * Proves, against a REAL PostgreSQL database:
 *   1. the P6B migrations applied successfully (implicit: every query below
 *      against CopyDesignOperation / CadCopyLineage / CopyDesignOperationEntry
 *      succeeds at all);
 *   2. the composite FK on CopyDesignOperationEntry.sourceFileVersion (and
 *      CadCopyLineage.sourceFileVersion) REJECTS a mismatched
 *      (sourceCadDocumentId, sourceFileVersionId) pair even when inserted
 *      DIRECTLY via Prisma, bypassing every application-level check;
 *   3. a multi-entry operation whose LATER insert fails (a real unique
 *      constraint violation partway through a hand-rolled multi-statement
 *      transaction) rolls back EVERYTHING - not just the failing statement;
 *   4. two concurrent requests using the SAME idempotencyKey against a REAL
 *      SERIALIZABLE transaction produce exactly ONE CopyDesignOperation (and
 *      ONE set of result entries) - never two;
 *   5. two concurrent requests proposing the SAME destination documentNumber
 *      (different idempotency keys) never both succeed - exactly one
 *      CadDocument ever exists with that number;
 *   6. the (organizationId, copyDesignOperationId, ordinal) unique
 *      constraint on CopyDesignOperationEntry is enforced by the database
 *      itself, independent of application logic.
 *   7. (P6B Round 3) the CopyDesignOperationEntry_source_shape_matches_action
 *      CHECK constraint - added in migration
 *      20260916200612_add_copy_design_operation_entry_source_shape_check -
 *      REJECTS every invalid (action, sourceCadDocumentId,
 *      sourceFileVersionId) combination (COPY with either source column
 *      null; REUSE with either source column populated) even when inserted
 *      DIRECTLY via Prisma, and ACCEPTS both valid shapes.
 *
 * Throwaway `ITEST-<rand>` org/user, direct PrismaClient, FK-safe cleanup at
 * the end. Never prints a password/token (this module needs neither).
 */
import { randomBytes } from "node:crypto";

import { PrismaClient } from "../app/generated/prisma/client.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  applyCopyDesignOperationForActor,
  CopyDesignConcurrencyConflictError,
  CopyDesignDestinationConflictError,
  type CopyDesignDb,
} from "../app/lib/copy-design-lineage-db.ts";

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
  const db = prisma as unknown as CopyDesignDb;

  const rand = randomBytes(4).toString("hex").toUpperCase();
  const orgCode = `ITEST-${rand}`;
  console.log(`P6B Copy Design real-Postgres gate — org ${orgCode}`);

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const org = await prisma.organization.create({ data: { name: `ITEST ${rand}`, code: orgCode } });
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `eng@${orgCode.toLowerCase()}.example`,
        name: "ITEST Engineer",
        role: UserRole.ENGINEER,
      },
    });
    const actor = { userId: user.id, organizationId: org.id, role: UserRole.ENGINEER, name: user.name, email: user.email };

    const src = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SRC`, fileName: "src.ipt", documentType: "IPT", createdById: user.id },
    });
    const srcFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: src.id, versionNumber: 1, originalFileName: "src.ipt", storageKey: `itest/${orgCode}/src-v1`, checksum: "deadbeef", fileSize: BigInt(1), createdById: user.id },
    });
    // A second, UNRELATED document + FileVersion pair - used to prove the
    // composite FK rejects a mismatched (sourceCadDocumentId,
    // sourceFileVersionId) combination.
    const other = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-OTHER`, fileName: "other.ipt", documentType: "IPT", createdById: user.id },
    });
    const otherFv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: other.id, versionNumber: 1, originalFileName: "other.ipt", storageKey: `itest/${orgCode}/other-v1`, checksum: "cafebabe", fileSize: BigInt(1), createdById: user.id },
    });

    cleanup = async () => {
      await prisma.copyDesignOperationEntry.deleteMany({ where: { organizationId: org.id } });
      await prisma.cadCopyLineage.deleteMany({ where: { organizationId: org.id } });
      await prisma.copyDesignOperation.deleteMany({ where: { organizationId: org.id } });
      await prisma.fileVersion.deleteMany({ where: { organizationId: org.id } });
      await prisma.cadDocument.deleteMany({ where: { organizationId: org.id } });
      await prisma.user.deleteMany({ where: { organizationId: org.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } });
    };

    // ---- (1) migration applied - implicit sanity ------------------------
    const entryTableReachable = await prisma.copyDesignOperationEntry.count({ where: { organizationId: org.id } });
    check("(1) CopyDesignOperationEntry table is reachable (migration applied)", entryTableReachable === 0);

    // ---- (2) composite FK rejects a mismatched source pair --------------
    // Set up a real CopyDesignOperation to satisfy the operation FK, so the
    // ONLY thing that can fail is the sourceFileVersion composite FK.
    const fkTestOp = await prisma.copyDesignOperation.create({
      data: { organizationId: org.id, idempotencyKey: `${orgCode}-fk-test`, performedById: user.id, requestPayload: {} },
    });
    await assertRejectsWithCode(
      () =>
        prisma.copyDesignOperationEntry.create({
          data: {
            organizationId: org.id,
            copyDesignOperationId: fkTestOp.id,
            ordinal: 0,
            action: "COPY",
            // MISMATCHED on purpose: sourceCadDocumentId names `src`, but
            // sourceFileVersionId names a FileVersion that actually belongs
            // to `other` - the composite FK must reject this pairing.
            sourceCadDocumentId: src.id,
            sourceFileVersionId: otherFv.id,
            resultingCadDocumentId: src.id,
            originalDocumentNumber: "X",
            originalFileName: "x.ipt",
            originalDocumentType: "IPT",
          },
        }),
      "P2003",
      (ok, detail) => check("(2) CopyDesignOperationEntry composite FK rejects mismatched source pair", ok, detail),
    );
    await assertRejectsWithCode(
      () =>
        prisma.cadCopyLineage.create({
          data: {
            organizationId: org.id,
            copyDesignOperationId: fkTestOp.id,
            newCadDocumentId: other.id,
            sourceCadDocumentId: src.id,
            sourceFileVersionId: otherFv.id, // same mismatch
            copiedById: user.id,
          },
        }),
      "P2003",
      (ok, detail) => check("(2b) CadCopyLineage composite FK rejects mismatched source pair (Round 1 regression check)", ok, detail),
    );
    // The CORRECT pairing must still succeed - proves the FK enforces the
    // pairing, not merely "any pair fails".
    const correctPairEntry = await prisma.copyDesignOperationEntry.create({
      data: {
        organizationId: org.id,
        copyDesignOperationId: fkTestOp.id,
        ordinal: 0,
        action: "COPY",
        sourceCadDocumentId: src.id,
        sourceFileVersionId: srcFv.id, // CORRECT pairing
        resultingCadDocumentId: other.id,
        originalDocumentNumber: "X",
        originalFileName: "x.ipt",
        originalDocumentType: "IPT",
      },
    });
    check("(2c) the CORRECT source pairing is accepted by the same FK", !!correctPairEntry.id);
    await prisma.copyDesignOperationEntry.delete({ where: { id: correctPairEntry.id } });
    await prisma.copyDesignOperation.delete({ where: { id: fkTestOp.id } });

    // ---- (6) ordinal uniqueness is enforced by the DATABASE --------------
    const ordinalTestOp = await prisma.copyDesignOperation.create({
      data: { organizationId: org.id, idempotencyKey: `${orgCode}-ordinal-test`, performedById: user.id, requestPayload: {} },
    });
    await prisma.copyDesignOperationEntry.create({
      data: {
        organizationId: org.id,
        copyDesignOperationId: ordinalTestOp.id,
        ordinal: 0,
        action: "REUSE",
        resultingCadDocumentId: other.id,
        originalDocumentNumber: other.documentNumber,
        originalFileName: other.fileName,
        originalDocumentType: "IPT",
      },
    });
    await assertRejectsWithCode(
      () =>
        prisma.copyDesignOperationEntry.create({
          data: {
            organizationId: org.id,
            copyDesignOperationId: ordinalTestOp.id,
            ordinal: 0, // DUPLICATE ordinal for the SAME operation
            action: "REUSE",
            resultingCadDocumentId: src.id,
            originalDocumentNumber: src.documentNumber,
            originalFileName: src.fileName,
            originalDocumentType: "IPT",
          },
        }),
      "P2002",
      (ok, detail) => check("(6) (organizationId, copyDesignOperationId, ordinal) unique constraint enforced by Postgres", ok, detail),
    );
    await prisma.copyDesignOperationEntry.deleteMany({ where: { copyDesignOperationId: ordinalTestOp.id } });
    await prisma.copyDesignOperation.delete({ where: { id: ordinalTestOp.id } });

    // ---- (7) P6B Round 3: CopyDesignOperationEntry_source_shape_matches_action
    // CHECK constraint - bypasses application validation entirely (direct
    // Prisma inserts), proving PostgreSQL itself rejects every invalid
    // (action, sourceCadDocumentId, sourceFileVersionId) combination and
    // accepts both valid ones. --------------------------------------------
    const checkTestOp = await prisma.copyDesignOperation.create({
      data: { organizationId: org.id, idempotencyKey: `${orgCode}-check-test`, performedById: user.id, requestPayload: {} },
    });
    let checkOrdinal = 0;
    await assertRejectsWithCheckViolation(
      () =>
        prisma.copyDesignOperationEntry.create({
          data: {
            organizationId: org.id,
            copyDesignOperationId: checkTestOp.id,
            ordinal: checkOrdinal++,
            action: "COPY",
            sourceCadDocumentId: null, // INVALID: COPY requires a non-null source document
            sourceFileVersionId: srcFv.id,
            resultingCadDocumentId: other.id,
            originalDocumentNumber: "X",
            originalFileName: "x.ipt",
            originalDocumentType: "IPT",
          },
        }),
      "CopyDesignOperationEntry_source_shape_matches_action",
      (ok, detail) => check("(7a) CHECK rejects COPY with null sourceCadDocumentId", ok, detail),
    );
    await assertRejectsWithCheckViolation(
      () =>
        prisma.copyDesignOperationEntry.create({
          data: {
            organizationId: org.id,
            copyDesignOperationId: checkTestOp.id,
            ordinal: checkOrdinal++,
            action: "COPY",
            sourceCadDocumentId: src.id,
            sourceFileVersionId: null, // INVALID: COPY requires a non-null source FileVersion
            resultingCadDocumentId: other.id,
            originalDocumentNumber: "X",
            originalFileName: "x.ipt",
            originalDocumentType: "IPT",
          },
        }),
      "CopyDesignOperationEntry_source_shape_matches_action",
      (ok, detail) => check("(7b) CHECK rejects COPY with null sourceFileVersionId", ok, detail),
    );
    await assertRejectsWithCheckViolation(
      () =>
        prisma.copyDesignOperationEntry.create({
          data: {
            organizationId: org.id,
            copyDesignOperationId: checkTestOp.id,
            ordinal: checkOrdinal++,
            action: "REUSE",
            sourceCadDocumentId: src.id, // INVALID: REUSE must have a null source document
            sourceFileVersionId: srcFv.id, // INVALID: REUSE must have a null source FileVersion
            resultingCadDocumentId: other.id,
            originalDocumentNumber: other.documentNumber,
            originalFileName: other.fileName,
            originalDocumentType: "IPT",
          },
        }),
      "CopyDesignOperationEntry_source_shape_matches_action",
      (ok, detail) => check("(7c) CHECK rejects REUSE with populated sourceCadDocumentId/sourceFileVersionId", ok, detail),
    );
    const validCopyEntry = await prisma.copyDesignOperationEntry.create({
      data: {
        organizationId: org.id,
        copyDesignOperationId: checkTestOp.id,
        ordinal: checkOrdinal++,
        action: "COPY",
        sourceCadDocumentId: src.id,
        sourceFileVersionId: srcFv.id,
        resultingCadDocumentId: other.id,
        originalDocumentNumber: "X",
        originalFileName: "x.ipt",
        originalDocumentType: "IPT",
      },
    });
    check("(7d) CHECK accepts a valid COPY (both source columns populated)", !!validCopyEntry.id);
    const validReuseEntry = await prisma.copyDesignOperationEntry.create({
      data: {
        organizationId: org.id,
        copyDesignOperationId: checkTestOp.id,
        ordinal: checkOrdinal++,
        action: "REUSE",
        resultingCadDocumentId: other.id,
        originalDocumentNumber: other.documentNumber,
        originalFileName: other.fileName,
        originalDocumentType: "IPT",
      },
    });
    check("(7e) CHECK accepts a valid REUSE (both source columns null)", !!validReuseEntry.id);
    // Direct confirmation the constraint itself exists in PostgreSQL (not
    // just that it happens to behave as expected above).
    const checkConstraintRows = await prisma.$queryRawUnsafe<Array<{ conname: string; pg_get_constraintdef: string }>>(
      `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = '"CopyDesignOperationEntry"'::regclass AND contype = 'c'`,
    );
    check(
      "(7f) CopyDesignOperationEntry_source_shape_matches_action CHECK constraint exists in PostgreSQL",
      checkConstraintRows.some((r) => r.conname === "CopyDesignOperationEntry_source_shape_matches_action"),
      JSON.stringify(checkConstraintRows),
    );
    await prisma.copyDesignOperationEntry.deleteMany({ where: { copyDesignOperationId: checkTestOp.id } });
    await prisma.copyDesignOperation.delete({ where: { id: checkTestOp.id } });

    // ---- (3) a later insert failing rolls back the WHOLE transaction -----
    const collider = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-COLLIDE`, fileName: "collide.ipt", documentType: "IPT", createdById: user.id },
    });
    const rollbackOpId = `rollback-op-${rand}`;
    await assertRejectsWithCode(
      () =>
        prisma.$transaction(async (tx) => {
          const op = await tx.copyDesignOperation.create({
            data: { organizationId: org.id, idempotencyKey: rollbackOpId, performedById: user.id, requestPayload: {} },
          });
          // First insert succeeds...
          const firstDoc = await tx.cadDocument.create({
            data: { organizationId: org.id, documentNumber: `${orgCode}-ROLLBACK-1`, fileName: "rb1.ipt", documentType: "IPT", createdById: user.id },
          });
          await tx.cadCopyLineage.create({
            data: { organizationId: org.id, copyDesignOperationId: op.id, newCadDocumentId: firstDoc.id, sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, copiedById: user.id },
          });
          await tx.copyDesignOperationEntry.create({
            data: { organizationId: org.id, copyDesignOperationId: op.id, ordinal: 0, action: "COPY", sourceCadDocumentId: src.id, sourceFileVersionId: srcFv.id, resultingCadDocumentId: firstDoc.id, originalDocumentNumber: firstDoc.documentNumber, originalFileName: firstDoc.fileName, originalDocumentType: "IPT" },
          });
          // ...the SECOND insert fails (real unique constraint violation on
          // an EXISTING document's number) - the entire transaction,
          // INCLUDING the first insert above, must roll back.
          await tx.cadDocument.create({
            data: { organizationId: org.id, documentNumber: collider.documentNumber, fileName: "rb2.ipt", documentType: "IPT", createdById: user.id },
          });
        }),
      "P2002",
      (ok, detail) => check("(3) a later insert failing throws (setup for rollback check)", ok, detail),
    );
    const [survivingOp, survivingDoc, survivingLineage, survivingEntry] = await Promise.all([
      prisma.copyDesignOperation.findFirst({ where: { organizationId: org.id, idempotencyKey: rollbackOpId } }),
      prisma.cadDocument.findFirst({ where: { organizationId: org.id, documentNumber: `${orgCode}-ROLLBACK-1` } }),
      prisma.cadCopyLineage.findFirst({ where: { organizationId: org.id, newCadDocument: { documentNumber: `${orgCode}-ROLLBACK-1` } } }),
      prisma.copyDesignOperationEntry.findFirst({ where: { organizationId: org.id, originalDocumentNumber: `${orgCode}-ROLLBACK-1` } }),
    ]);
    check(
      "(3) the WHOLE transaction rolled back - no operation, document, lineage, or entry survived",
      !survivingOp && !survivingDoc && !survivingLineage && !survivingEntry,
    );

    // ---- (4) concurrent SAME idempotency key -> exactly ONE operation ----
    const src2 = await prisma.cadDocument.create({
      data: { organizationId: org.id, documentNumber: `${orgCode}-SRC2`, fileName: "src2.ipt", documentType: "IPT", createdById: user.id },
    });
    const src2Fv = await prisma.fileVersion.create({
      data: { organizationId: org.id, cadDocumentId: src2.id, versionNumber: 1, originalFileName: "src2.ipt", storageKey: `itest/${orgCode}/src2-v1`, checksum: "f00dcafe", fileSize: BigInt(1), createdById: user.id },
    });
    const sameKeyRequest = {
      idempotencyKey: `${orgCode}-concurrent-samekey`,
      entries: [
        {
          action: "COPY" as const,
          sourceCadDocumentId: src2.id,
          sourceFileVersionId: src2Fv.id,
          newDocumentNumber: `${orgCode}-SAMEKEY-RESULT`,
          newFileName: "samekey.ipt",
          documentType: "IPT" as const,
        },
      ],
    };
    const sameKeyResults = await Promise.allSettled([
      applyCopyDesignOperationForActor(actor, sameKeyRequest, db),
      applyCopyDesignOperationForActor(actor, sameKeyRequest, db),
    ]);
    const sameKeyFulfilled = sameKeyResults.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof applyCopyDesignOperationForActor>>
    >[];
    check("(4) both concurrent same-key requests resolved successfully", sameKeyFulfilled.length === 2, JSON.stringify(sameKeyResults.map((r) => r.status)));
    if (sameKeyFulfilled.length === 2) {
      check(
        "(4) both concurrent same-key requests returned the SAME copyDesignOperationId",
        sameKeyFulfilled[0]!.value.copyDesignOperationId === sameKeyFulfilled[1]!.value.copyDesignOperationId,
      );
    }
    const sameKeyOpCount = await prisma.copyDesignOperation.count({ where: { organizationId: org.id, idempotencyKey: sameKeyRequest.idempotencyKey } });
    check("(4) exactly ONE CopyDesignOperation row exists for the shared idempotency key", sameKeyOpCount === 1, `got ${sameKeyOpCount}`);
    const sameKeyDocCount = await prisma.cadDocument.count({ where: { organizationId: org.id, documentNumber: sameKeyRequest.entries[0].newDocumentNumber } });
    check("(4) exactly ONE resulting CadDocument was created (not two)", sameKeyDocCount === 1, `got ${sameKeyDocCount}`);
    const sameKeyEntryCount = await prisma.copyDesignOperationEntry.count({ where: { organizationId: org.id, copyDesignOperationId: (await prisma.copyDesignOperation.findFirstOrThrow({ where: { organizationId: org.id, idempotencyKey: sameKeyRequest.idempotencyKey } })).id } });
    check("(4) exactly ONE CopyDesignOperationEntry row was written (not duplicated)", sameKeyEntryCount === 1, `got ${sameKeyEntryCount}`);

    // ---- (5) concurrent SAME destination documentNumber, DIFFERENT keys --
    const sharedDestinationNumber = `${orgCode}-CONTENDED-DEST`;
    const contendedRequestA = {
      idempotencyKey: `${orgCode}-contended-A`,
      entries: [
        {
          action: "COPY" as const,
          sourceCadDocumentId: src.id,
          sourceFileVersionId: srcFv.id,
          newDocumentNumber: sharedDestinationNumber,
          newFileName: "contended-a.ipt",
          documentType: "IPT" as const,
        },
      ],
    };
    const contendedRequestB = {
      idempotencyKey: `${orgCode}-contended-B`,
      entries: [
        {
          action: "COPY" as const,
          sourceCadDocumentId: src2.id,
          sourceFileVersionId: src2Fv.id,
          newDocumentNumber: sharedDestinationNumber, // SAME destination number
          newFileName: "contended-b.ipt",
          documentType: "IPT" as const,
        },
      ],
    };
    const contendedResults = await Promise.allSettled([
      applyCopyDesignOperationForActor(actor, contendedRequestA, db),
      applyCopyDesignOperationForActor(actor, contendedRequestB, db),
    ]);
    const contendedFulfilled = contendedResults.filter((r) => r.status === "fulfilled");
    const contendedRejected = contendedResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    check("(5) exactly one of the two contending requests succeeded", contendedFulfilled.length === 1, JSON.stringify(contendedResults.map((r) => r.status)));
    check(
      "(5) the loser failed with a controlled Copy Design conflict (destination collision or concurrency), never an unhandled error",
      contendedRejected.length === 1 &&
        (contendedRejected[0]!.reason instanceof CopyDesignDestinationConflictError ||
          contendedRejected[0]!.reason instanceof CopyDesignConcurrencyConflictError),
      contendedRejected[0] ? String((contendedRejected[0].reason as Error)?.name) : "no rejection",
    );
    const contendedDocCount = await prisma.cadDocument.count({ where: { organizationId: org.id, documentNumber: sharedDestinationNumber } });
    check("(5) exactly ONE CadDocument ever exists with the contended destination number", contendedDocCount === 1, `got ${contendedDocCount}`);
  } finally {
    if (cleanup) {
      try {
        await cleanup();
        console.log("  ok   ITEST rows cleaned up");
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

async function assertRejectsWithCode(
  fn: () => Promise<unknown>,
  code: string,
  report: (ok: boolean, detail?: string) => void,
): Promise<void> {
  try {
    await fn();
    report(false, "did not throw");
  } catch (error) {
    report(isPrismaErrorWithCode(error, code), isPrismaErrorWithCode(error, code) ? undefined : `got ${(error as { code?: string })?.code ?? String(error)}`);
  }
}

/**
 * A PostgreSQL CHECK violation (SQLSTATE 23514) surfaces from a normal
 * Prisma Client `create()` call as a `PrismaClientUnknownRequestError` with
 * NO `.code` field at all (unlike P2002/P2003, which Prisma maps to its own
 * known error codes) - the only reliable signal is the underlying Postgres
 * error text. Asserts the rejection names SQLSTATE 23514 and the exact
 * constraint name, so this cannot be satisfied by an unrelated failure.
 */
async function assertRejectsWithCheckViolation(
  fn: () => Promise<unknown>,
  constraintName: string,
  report: (ok: boolean, detail?: string) => void,
): Promise<void> {
  try {
    await fn();
    report(false, "did not throw");
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    const ok = message.includes("23514") && message.includes(constraintName);
    report(ok, ok ? undefined : `got ${message.slice(0, 200)}`);
  }
}

main().catch((error) => {
  console.error("integration gate crashed:", error);
  process.exit(1);
});
