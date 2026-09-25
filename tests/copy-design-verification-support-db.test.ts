/**
 * Focused tests for the P6E-A Copy Design verification-support Prisma-shaped
 * wiring (`app/lib/copy-design-verification-support-db.ts`). In-memory fake
 * DB - no real PostgreSQL required for these; a real-database round trip is
 * covered separately by a PostgreSQL integration script
 * (`scripts/itest-p6e-verification-support.ts`).
 *
 * P6E-A CONTRACT HARDENING: `sourceFileVersionIntegrity` now returns EXACTLY
 * ONE explicit evidence record (AVAILABLE / UNAVAILABLE / INVALID) per COPY
 * entry - these tests are numbered to match that round's exact required
 * scenario list.
 *
 * The fake database below deliberately exposes ONLY `findFirst`/`findMany`
 * methods - no `.create()` / `.update()` / `.delete()` / `.upsert()` /
 * `.deleteMany()` exist on it AT ALL, on any model. If the code under test
 * ever attempted a mutating call, it would throw "is not a function" - this
 * is the structural proof that verification-support performs NO mutation,
 * not merely a behavioral assertion.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-verification-support-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Actor } from "../app/lib/authz.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  CopyDesignOperationStatusNotFoundError,
  copyDesignVerificationSupportHttpResult,
  loadCopyDesignVerificationSupport,
  type CopyDesignVerificationSupportDb,
} from "../app/lib/copy-design-verification-support-db.ts";

// ------------------------------------------------------------
// In-memory fake database (READ-ONLY: no mutating method exists anywhere)
// ------------------------------------------------------------

interface OperationRow {
  organizationId: string;
  id: string;
  idempotencyKey: string;
  performedAt: Date;
}
interface EntryRow {
  organizationId: string;
  copyDesignOperationId: string;
  ordinal: number;
  action: "COPY" | "REUSE";
  sourceCadDocumentId: string | null;
  sourceFileVersionId?: string | null;
  resultingCadDocumentId: string;
  originalDocumentNumber: string;
  originalFileName: string;
  originalDocumentType: string;
  originalDescription?: string | null;
}
interface LineageRow {
  organizationId: string;
  copyDesignOperationId: string;
  newCadDocumentId: string;
  sourceCadDocumentId: string;
}
interface FileVersionRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: bigint | null;
}
interface DependencyRow {
  organizationId: string;
  parentDocumentId: string;
  childDocumentId: string;
  dependencyType: string;
}

class FakeDatabase {
  readonly operations: OperationRow[] = [];
  readonly entries: EntryRow[] = [];
  readonly lineages: LineageRow[] = [];
  readonly versions: FileVersionRow[] = [];
  readonly dependencies: DependencyRow[] = [];

  /** Records exactly which `select` fields every `fileVersion.findMany` call
   *  asked for - proves `storageKey` (the field that would let a caller
   *  stream binary content) is never even requested. */
  readonly fileVersionSelectsRequested: Array<Record<string, unknown>> = [];

  addOperation(row: OperationRow): this {
    this.operations.push(row);
    return this;
  }
  addEntry(row: EntryRow): this {
    this.entries.push(row);
    return this;
  }
  addLineage(row: LineageRow): this {
    this.lineages.push(row);
    return this;
  }
  addVersion(row: FileVersionRow): this {
    this.versions.push(row);
    return this;
  }
  /** Adds the SAME logical row twice (same id) - simulates a query plan
   *  that, for whatever reason, returns a duplicate row for one id. Used by
   *  test 6 to prove the code never produces two evidence records for one
   *  entry regardless. */
  addDuplicatedVersion(row: FileVersionRow): this {
    this.versions.push(row, { ...row });
    return this;
  }
  addDependency(row: DependencyRow): this {
    this.dependencies.push(row);
    return this;
  }

  asDb(): CopyDesignVerificationSupportDb {
    return {
      copyDesignOperation: {
        findFirst: (async (args: any) => {
          const op = this.operations.find(
            (o) => o.organizationId === args.where.organizationId && o.id === args.where.id,
          );
          if (!op) return null;
          const entries = this.entries
            .filter((e) => e.organizationId === op.organizationId && e.copyDesignOperationId === op.id)
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((e) => ({
              ordinal: e.ordinal,
              action: e.action,
              sourceCadDocumentId: e.sourceCadDocumentId,
              sourceFileVersionId: e.sourceFileVersionId ?? null,
              resultingCadDocumentId: e.resultingCadDocumentId,
              originalDocumentNumber: e.originalDocumentNumber,
              originalFileName: e.originalFileName,
              originalDocumentType: e.originalDocumentType,
              originalDescription: e.originalDescription ?? null,
            }));
          return { id: op.id, idempotencyKey: op.idempotencyKey, performedAt: op.performedAt, entries };
        }) as any,
      } as any,
      cadCopyLineage: {
        findMany: (async (args: any) => {
          const ids: string[] = args.where.newCadDocumentId.in;
          return this.lineages
            .filter(
              (l) =>
                l.organizationId === args.where.organizationId &&
                l.copyDesignOperationId === args.where.copyDesignOperationId &&
                ids.includes(l.newCadDocumentId),
            )
            .map((l) => ({ newCadDocumentId: l.newCadDocumentId, sourceCadDocumentId: l.sourceCadDocumentId }));
        }) as any,
      } as any,
      fileVersion: {
        findMany: (async (args: any) => {
          this.fileVersionSelectsRequested.push(args.select ?? {});
          // Two distinct call shapes reach this fake: operation-status's own
          // cadDocumentId-keyed lookup (destination side, unchanged from
          // P6D) and verification-support's NEW id-keyed lookup (source
          // side) - distinguished by which `where` key is present.
          if (args.where.cadDocumentId) {
            const ids: string[] = args.where.cadDocumentId.in;
            return this.versions
              .filter((v) => v.organizationId === args.where.organizationId && ids.includes(v.cadDocumentId))
              .map((v) => ({
                id: v.id,
                cadDocumentId: v.cadDocumentId,
                versionNumber: v.versionNumber,
                checksum: v.checksum,
                fileSize: v.fileSize,
              }));
          }
          const ids: string[] = args.where.id.in;
          return this.versions
            .filter((v) => v.organizationId === args.where.organizationId && ids.includes(v.id))
            .map((v) => ({ id: v.id, cadDocumentId: v.cadDocumentId, checksum: v.checksum, fileSize: v.fileSize }));
        }) as any,
      } as any,
      cadDependency: {
        findMany: (async (args: any) => {
          const parentIds: string[] = args.where.parentDocumentId.in;
          const childIds: string[] = args.where.childDocumentId.in;
          return this.dependencies
            .filter(
              (d) =>
                d.organizationId === args.where.organizationId &&
                d.dependencyType === args.where.dependencyType &&
                parentIds.includes(d.parentDocumentId) &&
                childIds.includes(d.childDocumentId),
            )
            .sort((a, b) =>
              a.parentDocumentId !== b.parentDocumentId
                ? a.parentDocumentId < b.parentDocumentId ? -1 : 1
                : a.childDocumentId < b.childDocumentId ? -1 : a.childDocumentId > b.childDocumentId ? 1 : 0,
            )
            .map((d) => ({ parentDocumentId: d.parentDocumentId, childDocumentId: d.childDocumentId }));
        }) as any,
      } as any,
    };
  }
}

const ORG = "org-1";

function actor(overrides: Partial<Actor> = {}): Actor {
  return { userId: "user-1", organizationId: ORG, role: UserRole.ENGINEER, ...overrides } as Actor;
}

function copyEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    organizationId: ORG,
    copyDesignOperationId: "op-1",
    ordinal: 0,
    action: "COPY",
    sourceCadDocumentId: "cad-src",
    sourceFileVersionId: "fv-src",
    resultingCadDocumentId: "cad-new",
    originalDocumentNumber: "1002",
    originalFileName: "part.ipt",
    originalDocumentType: "IPT",
    ...overrides,
  };
}

// ------------------------------------------------------------
// identity / tenant behavior (mirrors operation-status exactly)
// ------------------------------------------------------------

test("an authenticated same-tenant operation succeeds and embeds the operation-status payload verbatim", async () => {
  const fake = new FakeDatabase().addOperation({
    organizationId: ORG,
    id: "op-1",
    idempotencyKey: "key-1",
    performedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");

  assert.equal(dto.contract, "arch-plm.copy-design-verification-support.v1");
  assert.equal(dto.copyDesignOperationId, "op-1");
  assert.equal(dto.operationStatus.contract, "arch-plm.copy-design-operation-status.v1");
  assert.equal(dto.operationStatus.copyDesignOperationId, "op-1");
  assert.equal(dto.operationStatus.idempotencyKey, "key-1");
  assert.deepEqual(dto.sourceFileVersionIntegrity, []);
  assert.deepEqual(dto.componentEdges, []);
});

test("10a. unknown operation and foreign-tenant operation throw the SAME NotFound error - indistinguishable", async () => {
  const unknown = new FakeDatabase();
  await assert.rejects(
    () => loadCopyDesignVerificationSupport(unknown.asDb(), ORG, "op-missing"),
    CopyDesignOperationStatusNotFoundError,
  );

  const foreignTenant = new FakeDatabase().addOperation({
    organizationId: "org-OTHER",
    id: "op-1",
    idempotencyKey: "key-1",
    performedAt: new Date(),
  });
  await assert.rejects(
    () => loadCopyDesignVerificationSupport(foreignTenant.asDb(), ORG, "op-1"),
    CopyDesignOperationStatusNotFoundError,
  );

  // HTTP level: both map to the exact same 404 status/body shape.
  const httpUnknown = await copyDesignVerificationSupportHttpResult(actor(), "op-missing", unknown.asDb());
  const httpForeign = await copyDesignVerificationSupportHttpResult(actor(), "op-1", foreignTenant.asDb());
  assert.equal(httpUnknown.status, 404);
  assert.equal(httpForeign.status, 404);
  assert.deepEqual(httpUnknown.body, httpForeign.body);
});

// ------------------------------------------------------------
// 1-8: COPY source-integrity evidence states (AVAILABLE / UNAVAILABLE / INVALID)
// ------------------------------------------------------------

test("1. every valid COPY entry gets exactly one AVAILABLE evidence record", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 3, checksum: "c".repeat(64), fileSize: 555n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 1);
  assert.deepEqual(dto.sourceFileVersionIntegrity[0], {
    ordinal: 0, sourceCadDocumentId: "cad-src", sourceFileVersionId: "fv-src",
    state: "AVAILABLE", sha256: "c".repeat(64), fileSize: 555,
  });
});

test("2. a missing COPY source FileVersion row is an explicit UNAVAILABLE record, never a silent omission", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" });
  // deliberately no FileVersion row added at all

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 1);
  assert.deepEqual(dto.sourceFileVersionIntegrity[0], {
    ordinal: 0, sourceCadDocumentId: "cad-src", sourceFileVersionId: "fv-src", state: "UNAVAILABLE",
  });
});

test("3. a malformed (non-canonical) checksum is an explicit INVALID record", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 1, checksum: "NOT-CANONICAL", fileSize: 100n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 1);
  const record = dto.sourceFileVersionIntegrity[0]!;
  assert.equal(record.state, "INVALID");
  assert.equal((record as { reason: string }).reason, "non-canonical checksum");
  assert.equal("sha256" in record, false);
});

test("4. a malformed (out-of-range) fileSize is an explicit INVALID record", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 1, checksum: "a".repeat(64), fileSize: -1n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 1);
  const record = dto.sourceFileVersionIntegrity[0]!;
  assert.equal(record.state, "INVALID");
  assert.equal((record as { reason: string }).reason, "fileSize not representable");
});

test("4b. a null checksum is also an explicit INVALID record (not UNAVAILABLE - the row exists)", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 1, checksum: null, fileSize: 100n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity[0]!.state, "INVALID");
});

test("5. a source FileVersion row that belongs to a DIFFERENT CadDocument (mismatched ownership) is an explicit INVALID record", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ sourceCadDocumentId: "cad-src-CLAIMED", sourceFileVersionId: "fv-src" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src-CLAIMED" })
    // The row genuinely EXISTS (proving this is not "missing") but is owned
    // by a DIFFERENT CadDocument than the entry claims.
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src-ACTUAL-OWNER", id: "fv-src", versionNumber: 1, checksum: "b".repeat(64), fileSize: 100n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 1);
  const record = dto.sourceFileVersionIntegrity[0]!;
  // Most truthful classification: the row EXISTS (so "cannot be found" would
  // be false) but is INCONSISTENT with what this entry claims - INVALID,
  // never UNAVAILABLE (which would wrongly suggest "nothing was found").
  assert.equal(record.state, "INVALID");
  assert.equal(
    (record as { reason: string }).reason,
    "the source FileVersion belongs to a different CadDocument than sourceCadDocumentId names",
  );
});

test("6. a duplicated underlying row for the SAME sourceFileVersionId cannot create a duplicate evidence record", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addDuplicatedVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 1, checksum: "d".repeat(64), fileSize: 77n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 1);
  assert.equal(dto.sourceFileVersionIntegrity[0]!.state, "AVAILABLE");
});

test("6b. two DIFFERENT COPY entries copying the SAME source FileVersion each get their OWN evidence record (one per entry, not deduplicated across entries)", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ ordinal: 0, resultingCadDocumentId: "cad-new-1" }))
    .addEntry(copyEntry({ ordinal: 1, resultingCadDocumentId: "cad-new-2" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new-1", sourceCadDocumentId: "cad-src" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new-2", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 1, checksum: "d".repeat(64), fileSize: 77n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.sourceFileVersionIntegrity.length, 2);
  assert.deepEqual(dto.sourceFileVersionIntegrity.map((r) => r.ordinal), [0, 1]);
  assert.ok(dto.sourceFileVersionIntegrity.every((r) => r.state === "AVAILABLE"));
});

test("7. evidence records follow the operation entry ordinal order deterministically, regardless of insertion order", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    // Inserted out of ordinal order on purpose.
    .addEntry(copyEntry({ ordinal: 2, sourceCadDocumentId: "cad-c", sourceFileVersionId: "fv-c", resultingCadDocumentId: "cad-c-new" }))
    .addEntry(copyEntry({ ordinal: 0, sourceCadDocumentId: "cad-a", sourceFileVersionId: "fv-a", resultingCadDocumentId: "cad-a-new" }))
    .addEntry(copyEntry({ ordinal: 1, sourceCadDocumentId: "cad-b", sourceFileVersionId: "fv-b", resultingCadDocumentId: "cad-b-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-a-new", sourceCadDocumentId: "cad-a" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-b-new", sourceCadDocumentId: "cad-b" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-c-new", sourceCadDocumentId: "cad-c" });
  // No FileVersion rows at all - every entry is UNAVAILABLE; ordering is
  // what's under test here, not state.

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.sourceFileVersionIntegrity.map((r) => r.ordinal), [0, 1, 2]);
  assert.deepEqual(dto.sourceFileVersionIntegrity.map((r) => r.sourceCadDocumentId), ["cad-a", "cad-b", "cad-c"]);

  const second = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto, second);
});

test("8. a REUSE entry produces NO fabricated historical integrity record - P6D never freezes one for REUSE", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
      organizationId: ORG,
      copyDesignOperationId: "op-1",
      ordinal: 0,
      action: "REUSE",
      sourceCadDocumentId: null,
      resultingCadDocumentId: "cad-reused",
      originalDocumentNumber: "1001",
      originalFileName: "bolt.ipt",
      originalDocumentType: "IPT",
    })
    // Even though the reused CadDocument genuinely HAS a FileVersion (it
    // must, being an existing materialized document), verification-support
    // never looks it up for a REUSE entry: CopyDesignOperationEntry never
    // pins WHICH version was "current" at operation time for a REUSE row
    // (sourceFileVersionId is always NULL - DB CHECK constraint enforced) -
    // there is no historical baseline to report, so NONE is reported, and
    // none is invented.
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-reused", id: "fv-current", versionNumber: 1, checksum: "f".repeat(64), fileSize: 42n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.equal(dto.operationStatus.entries[0]!.action, "REUSE");
  assert.deepEqual(dto.sourceFileVersionIntegrity, []);
});

// ------------------------------------------------------------
// 9: mixed COPY/REUSE topology
// ------------------------------------------------------------

test("9. a mixed COPY/REUSE operation still includes the REUSE identity in COMPONENT topology edges", async () => {
  // MAIN (COPY) -> SUB-A (REUSE) -> A1 (COPY): SUB-A is REUSE'd, but its own
  // child A1 must still appear in componentEdges via SUB-A's resultingCadDocumentId
  // (== its own original identity - a REUSE never gets a new id).
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ ordinal: 0, sourceCadDocumentId: "cad-main", sourceFileVersionId: "fv-main", resultingCadDocumentId: "cad-main-new" }))
    .addEntry({
      organizationId: ORG, copyDesignOperationId: "op-1", ordinal: 1, action: "REUSE",
      sourceCadDocumentId: null, resultingCadDocumentId: "cad-suba",
      originalDocumentNumber: "SUBA", originalFileName: "suba.iam", originalDocumentType: "IAM",
    })
    .addEntry(copyEntry({ ordinal: 2, sourceCadDocumentId: "cad-a1", sourceFileVersionId: "fv-a1", resultingCadDocumentId: "cad-a1-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-main-new", sourceCadDocumentId: "cad-main" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-a1-new", sourceCadDocumentId: "cad-a1" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-main", childDocumentId: "cad-suba", dependencyType: "COMPONENT" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-suba", childDocumentId: "cad-a1", dependencyType: "COMPONENT" });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.componentEdges, [
    { parentCadDocumentId: "cad-main", childCadDocumentId: "cad-suba" },
    { parentCadDocumentId: "cad-suba", childCadDocumentId: "cad-a1" },
  ]);
});

// ------------------------------------------------------------
// 10: previous tenant-isolation / read-only / topology / no-binary tests,
//     kept and still passing
// ------------------------------------------------------------

test("10b. a COMPONENT edge is returned when both parent and child belong to the operation", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ ordinal: 0, sourceCadDocumentId: "cad-main", sourceFileVersionId: "fv-main", resultingCadDocumentId: "cad-main-new" }))
    .addEntry(copyEntry({ ordinal: 1, sourceCadDocumentId: "cad-part-a", sourceFileVersionId: "fv-a", resultingCadDocumentId: "cad-a-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-main-new", sourceCadDocumentId: "cad-main" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-a-new", sourceCadDocumentId: "cad-part-a" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-main", childDocumentId: "cad-part-a", dependencyType: "COMPONENT" });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.componentEdges, [{ parentCadDocumentId: "cad-main", childCadDocumentId: "cad-part-a" }]);
});

test("10c. a nested (multi-level) COMPONENT topology is returned completely - MAIN -> SUB-A -> A1", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ ordinal: 0, sourceCadDocumentId: "cad-main", sourceFileVersionId: "fv-main", resultingCadDocumentId: "cad-main-new" }))
    .addEntry(copyEntry({ ordinal: 1, sourceCadDocumentId: "cad-suba", sourceFileVersionId: "fv-suba", resultingCadDocumentId: "cad-suba-new" }))
    .addEntry(copyEntry({ ordinal: 2, sourceCadDocumentId: "cad-a1", sourceFileVersionId: "fv-a1", resultingCadDocumentId: "cad-a1-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-main-new", sourceCadDocumentId: "cad-main" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-suba-new", sourceCadDocumentId: "cad-suba" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-a1-new", sourceCadDocumentId: "cad-a1" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-main", childDocumentId: "cad-suba", dependencyType: "COMPONENT" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-suba", childDocumentId: "cad-a1", dependencyType: "COMPONENT" });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.componentEdges, [
    { parentCadDocumentId: "cad-main", childCadDocumentId: "cad-suba" },
    { parentCadDocumentId: "cad-suba", childCadDocumentId: "cad-a1" },
  ]);
});

test("10d. an edge whose PARENT is outside the operation is excluded", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ sourceCadDocumentId: "cad-src", sourceFileVersionId: "fv-src", resultingCadDocumentId: "cad-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-UNRELATED-PARENT", childDocumentId: "cad-src", dependencyType: "COMPONENT" });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.componentEdges, []);
});

test("10e. an edge whose CHILD is outside the operation is excluded", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ sourceCadDocumentId: "cad-src", sourceFileVersionId: "fv-src", resultingCadDocumentId: "cad-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-src", childDocumentId: "cad-UNRELATED-CHILD", dependencyType: "COMPONENT" });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.componentEdges, []);
});

test("10f. a dependency row from another tenant, even with matching ids, is excluded", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry({ ordinal: 0, sourceCadDocumentId: "cad-main", sourceFileVersionId: "fv-main", resultingCadDocumentId: "cad-main-new" }))
    .addEntry(copyEntry({ ordinal: 1, sourceCadDocumentId: "cad-part-a", sourceFileVersionId: "fv-a", resultingCadDocumentId: "cad-a-new" }))
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-main-new", sourceCadDocumentId: "cad-main" })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-a-new", sourceCadDocumentId: "cad-part-a" })
    .addDependency({ organizationId: "org-OTHER", parentDocumentId: "cad-main", childDocumentId: "cad-part-a", dependencyType: "COMPONENT" });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.componentEdges, []);
});

test("10g. no binary content is ever requested or returned - fileVersion.findMany never selects storageKey", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-src", id: "fv-src", versionNumber: 1, checksum: "e".repeat(64), fileSize: 9n });

  const dto = await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
  assert.ok(dto);
  assert.ok(fake.fileVersionSelectsRequested.length > 0);
  for (const select of fake.fileVersionSelectsRequested) {
    assert.equal("storageKey" in select, false, "storageKey must never be selected - metadata only");
  }
  assert.equal(JSON.stringify(dto).toLowerCase().includes("storagekey"), false);
});

test("10h. no mutation occurs - the fake database exposes ONLY read methods, proving no create/update/delete was ever attempted", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry(copyEntry())
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addDependency({ organizationId: ORG, parentDocumentId: "cad-src", childDocumentId: "cad-src", dependencyType: "COMPONENT" });

  const db = fake.asDb() as any;
  for (const model of ["copyDesignOperation", "cadCopyLineage", "fileVersion", "cadDependency"]) {
    for (const mutator of ["create", "update", "delete", "upsert", "deleteMany", "updateMany", "createMany"]) {
      assert.equal(typeof db[model][mutator], "undefined", `${model}.${mutator} must not exist on this fake`);
    }
  }
  await loadCopyDesignVerificationSupport(fake.asDb(), ORG, "op-1");
});

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

test("http: no actor is 401", async () => {
  const fake = new FakeDatabase();
  const { status, body } = await copyDesignVerificationSupportHttpResult(null, "op-1", fake.asDb());
  assert.equal(status, 401);
  assert.ok((body as any).error);
});
