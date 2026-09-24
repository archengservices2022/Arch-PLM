/**
 * Focused tests for the P6D ROUND 3 operation status Prisma-shaped wiring
 * (`app/lib/copy-design-operation-status-db.ts`). In-memory fake DB - no real
 * PostgreSQL required for these; a real-database round trip is covered
 * separately by a PostgreSQL integration script.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-operation-status-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Actor } from "../app/lib/authz.ts";
import { UserRole } from "../app/generated/prisma/enums.ts";
import {
  CopyDesignOperationStatusNotFoundError,
  copyDesignOperationStatusHttpResult,
  loadCopyDesignOperationStatus,
  type CopyDesignOperationStatusDb,
} from "../app/lib/copy-design-operation-status-db.ts";

// ------------------------------------------------------------
// In-memory fake database
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

class FakeDatabase {
  readonly operations: OperationRow[] = [];
  readonly entries: EntryRow[] = [];
  readonly lineages: LineageRow[] = [];
  readonly versions: FileVersionRow[] = [];

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

  asDb(): CopyDesignOperationStatusDb {
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
        }) as any,
      } as any,
    };
  }
}

const ORG = "org-1";

function actor(overrides: Partial<Actor> = {}): Actor {
  return { userId: "user-1", organizationId: ORG, role: UserRole.ENGINEER, ...overrides } as Actor;
}

test("throws NotFound for an unknown operationId", async () => {
  const fake = new FakeDatabase();
  await assert.rejects(
    () => loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-missing"),
    CopyDesignOperationStatusNotFoundError,
  );
});

test("throws NotFound for an operation that exists but in a DIFFERENT organization", async () => {
  const fake = new FakeDatabase().addOperation({
    organizationId: "org-OTHER",
    id: "op-1",
    idempotencyKey: "key-1",
    performedAt: new Date(),
  });
  await assert.rejects(
    () => loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1"),
    CopyDesignOperationStatusNotFoundError,
  );
});

test("a REUSE entry is always REUSED, regardless of any FileVersion state", async () => {
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
    });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries.length, 1);
  assert.deepEqual(dto.entries[0], {
    ordinal: 0,
    action: "REUSE",
    state: "REUSED",
    resultingCadDocumentId: "cad-reused",
    originalDocumentNumber: "1001",
    originalFileName: "bolt.ipt",
    originalDocumentType: "IPT",
    originalDescription: null,
  });
});

// P6D ROUND 4, item D: originalDescription is part of the immutable
// snapshot and must be returned verbatim - previously omitted from this
// DTO entirely.
test("originalDescription is threaded through verbatim when present", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
      originalDescription: "Bracket, left-hand",
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.originalDescription, "Bracket, left-hand");
});

test("a COPY entry with zero FileVersion rows and proven lineage is PENDING", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "PENDING");
  assert.equal((dto.entries[0] as any).sourceCadDocumentId, "cad-src");
  assert.equal((dto.entries[0] as any).sourceFileVersionId, "fv-src");
});

// P6D PRODUCTION RECOVERY: sourceFileVersionId is the ONE minimal, additive
// field a durable resume reconstruction needs - previously omitted from
// this DTO entirely (only sourceCadDocumentId was exposed).
test("sourceFileVersionId is threaded through for every COPY state (PENDING/MATERIALIZED/INVALID)", async () => {
  const pending = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
      organizationId: ORG, copyDesignOperationId: "op-1", ordinal: 0, action: "COPY",
      sourceCadDocumentId: "cad-src", sourceFileVersionId: "fv-src", resultingCadDocumentId: "cad-new",
      originalDocumentNumber: "1002", originalFileName: "part.ipt", originalDocumentType: "IPT",
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" });
  const pendingDto = await loadCopyDesignOperationStatus(pending.asDb(), ORG, "op-1");
  assert.equal((pendingDto.entries[0] as any).sourceFileVersionId, "fv-src");

  // missing sourceFileVersionId on an otherwise COPY-shaped row -> INVALID,
  // never silently treated as PENDING (mirrors the existing
  // missing-sourceCadDocumentId behavior).
  const missingFv = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
      organizationId: ORG, copyDesignOperationId: "op-1", ordinal: 0, action: "COPY",
      sourceCadDocumentId: "cad-src", sourceFileVersionId: null, resultingCadDocumentId: "cad-new",
      originalDocumentNumber: "1002", originalFileName: "part.ipt", originalDocumentType: "IPT",
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" });
  const missingFvDto = await loadCopyDesignOperationStatus(missingFv.asDb(), ORG, "op-1");
  assert.equal(missingFvDto.entries[0]!.state, "INVALID");
});

test("a COPY entry with NO matching lineage row is INVALID, never PENDING", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    });
  // deliberately NO lineage row added

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "INVALID");
});

test("a COPY entry whose lineage row names a DIFFERENT source is INVALID", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
      organizationId: ORG,
      copyDesignOperationId: "op-1",
      ordinal: 0,
      action: "COPY",
      sourceCadDocumentId: "cad-src-CLAIMED",
      sourceFileVersionId: "fv-src",
      resultingCadDocumentId: "cad-new",
      originalDocumentNumber: "1002",
      originalFileName: "part.ipt",
      originalDocumentType: "IPT",
    })
    .addLineage({
      organizationId: ORG,
      copyDesignOperationId: "op-1",
      newCadDocumentId: "cad-new",
      sourceCadDocumentId: "cad-src-ACTUAL-DIFFERENT",
    });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "INVALID");
});

test("a COPY entry with exactly one canonical versionNumber-1 FileVersion is MATERIALIZED", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({
      organizationId: ORG,
      cadDocumentId: "cad-new",
      id: "fv-1",
      versionNumber: 1,
      checksum: "a".repeat(64),
      fileSize: 1024n,
    });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.deepEqual(dto.entries[0], {
    ordinal: 0,
    action: "COPY",
    state: "MATERIALIZED",
    sourceCadDocumentId: "cad-src",
    sourceFileVersionId: "fv-src",
    resultingCadDocumentId: "cad-new",
    originalDocumentNumber: "1002",
    originalFileName: "part.ipt",
    originalDocumentType: "IPT",
    originalDescription: null,
    fileVersionId: "fv-1",
    versionNumber: 1,
    sha256: "a".repeat(64),
    fileSize: 1024,
  });
});

test("a lone versionNumber-1 row with a non-canonical checksum is INVALID, never MATERIALIZED", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-new", id: "fv-1", versionNumber: 1, checksum: null, fileSize: 1024n });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "INVALID");
});

test("a lone versionNumber-1 row with an out-of-range fileSize is INVALID, never MATERIALIZED", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({
      organizationId: ORG,
      cadDocumentId: "cad-new",
      id: "fv-1",
      versionNumber: 1,
      checksum: "a".repeat(64),
      fileSize: -1n,
    });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "INVALID");
});

test("more than one FileVersion row for the target is INVALID", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-new", id: "fv-1", versionNumber: 1, checksum: "a".repeat(64), fileSize: 1024n })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-new", id: "fv-2", versionNumber: 2, checksum: "b".repeat(64), fileSize: 2048n });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "INVALID");
});

test("a lone FileVersion row whose versionNumber is not 1 is INVALID", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" })
    .addVersion({ organizationId: ORG, cadDocumentId: "cad-new", id: "fv-2", versionNumber: 2, checksum: "a".repeat(64), fileSize: 1024n });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries[0]!.state, "INVALID");
});

test("mixed COPY and REUSE entries preserve original ordinal order and are each classified independently", async () => {
  const fake = new FakeDatabase()
    .addOperation({ organizationId: ORG, id: "op-1", idempotencyKey: "key-1", performedAt: new Date() })
    .addEntry({
      organizationId: ORG,
      copyDesignOperationId: "op-1",
      ordinal: 1,
      action: "REUSE",
      sourceCadDocumentId: null,
      resultingCadDocumentId: "cad-reused",
      originalDocumentNumber: "1001",
      originalFileName: "bolt.ipt",
      originalDocumentType: "IPT",
    })
    .addEntry({
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
    })
    .addLineage({ organizationId: ORG, copyDesignOperationId: "op-1", newCadDocumentId: "cad-new", sourceCadDocumentId: "cad-src" });

  const dto = await loadCopyDesignOperationStatus(fake.asDb(), ORG, "op-1");
  assert.equal(dto.entries.length, 2);
  assert.equal(dto.entries[0]!.ordinal, 0);
  assert.equal(dto.entries[0]!.action, "COPY");
  assert.equal(dto.entries[0]!.state, "PENDING");
  assert.equal(dto.entries[1]!.ordinal, 1);
  assert.equal(dto.entries[1]!.action, "REUSE");
  assert.equal(dto.entries[1]!.state, "REUSED");
});

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

test("http: no actor is 401", async () => {
  const fake = new FakeDatabase();
  const { status, body } = await copyDesignOperationStatusHttpResult(null, "op-1", fake.asDb());
  assert.equal(status, 401);
  assert.ok((body as any).error);
});

test("http: unknown operation is 404", async () => {
  const fake = new FakeDatabase();
  const { status } = await copyDesignOperationStatusHttpResult(actor(), "op-missing", fake.asDb());
  assert.equal(status, 404);
});

test("http: a found operation is 200 with the DTO body", async () => {
  const fake = new FakeDatabase().addOperation({
    organizationId: ORG,
    id: "op-1",
    idempotencyKey: "key-1",
    performedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const { status, body } = await copyDesignOperationStatusHttpResult(actor(), "op-1", fake.asDb());
  assert.equal(status, 200);
  assert.equal((body as any).contract, "arch-plm.copy-design-operation-status.v1");
  assert.equal((body as any).copyDesignOperationId, "op-1");
  assert.equal((body as any).idempotencyKey, "key-1");
  assert.deepEqual((body as any).entries, []);
});

test("http: a cross-tenant operationId is 404, never leaking existence in another org", async () => {
  const fake = new FakeDatabase().addOperation({
    organizationId: "org-OTHER",
    id: "op-1",
    idempotencyKey: "key-1",
    performedAt: new Date(),
  });
  const { status } = await copyDesignOperationStatusHttpResult(actor({ organizationId: ORG }), "op-1", fake.asDb());
  assert.equal(status, 404);
});
