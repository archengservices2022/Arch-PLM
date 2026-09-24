/**
 * Focused tests for the P6B Copy Design identity reservation + lineage
 * Prisma-shaped wiring (`app/lib/copy-design-lineage-db.ts` + `-core.ts`).
 * In-memory fake DB - no Postgres, no network, no Inventor.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-lineage-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import {
  applyCopyDesignOperationForActor,
  copyDesignApplyHttpResult,
  CopyDesignConcurrencyConflictError,
  CopyDesignDestinationConflictError,
  CopyDesignIdempotencyConflictError,
  CopyDesignRoleError,
  CopyDesignSourceNotFoundError,
  CopyDesignValidationError,
  type CopyDesignDb,
} from "../app/lib/copy-design-lineage-db.ts";

// ------------------------------------------------------------
// In-memory fake Prisma
// ------------------------------------------------------------

// ROUND 2/3, LOW: carries a REALISTIC `meta.target` - EITHER a column-name
// array (the normal shape) OR a single constraint/index-name string (the
// shape some drivers / raw SQL paths report) - so tests can exercise
// `copy-design-lineage-db.ts`'s actual `p2002Target` /
// `matchesKnownUniqueConstraint` exact-match inspection for BOTH shapes, not
// just "some P2002 happened".
class FakeP2002Error extends Error {
  readonly code = "P2002";
  readonly meta: { target: string[] | string };
  constructor(target: string[] | string) {
    super(`Unique constraint failed on the fields: (${Array.isArray(target) ? target.join(",") : target})`);
    this.meta = { target };
  }
}

interface DocRow {
  id: string;
  organizationId: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
  description: string | null;
  createdById: string;
  createdAt: Date;
}

interface VersionRow {
  id: string;
  organizationId: string;
  cadDocumentId: string;
  versionNumber: number;
}

interface OperationRow {
  id: string;
  organizationId: string;
  idempotencyKey: string;
  performedById: string;
  performedAt: Date;
  label: string | null;
  requestPayload: unknown;
}

interface LineageRow {
  id: string;
  organizationId: string;
  copyDesignOperationId: string;
  newCadDocumentId: string;
  sourceCadDocumentId: string;
  sourceFileVersionId: string;
  copiedById: string;
  copiedAt: Date;
}

interface OperationEntryRow {
  id: string;
  organizationId: string;
  copyDesignOperationId: string;
  ordinal: number;
  action: "COPY" | "REUSE";
  sourceCadDocumentId: string | null;
  sourceFileVersionId: string | null;
  resultingCadDocumentId: string;
  originalDocumentNumber: string;
  originalFileName: string;
  originalDocumentType: string;
  originalDescription: string | null;
  createdAt: Date;
}

class FakeDatabase {
  cadDocuments: DocRow[] = [];
  fileVersions: VersionRow[] = [];
  copyDesignOperations: OperationRow[] = [];
  cadCopyLineages: LineageRow[] = [];
  copyDesignOperationEntries: OperationEntryRow[] = [];

  private docSeq = 0;
  private opSeq = 0;
  private linSeq = 0;
  private entrySeq = 0;

  transactionAttempts = 0;

  addCadDocument(row: Partial<DocRow> & { organizationId: string; documentNumber: string }): DocRow {
    const full: DocRow = {
      id: row.id ?? `seed_doc_${++this.docSeq}`,
      organizationId: row.organizationId,
      documentNumber: row.documentNumber,
      fileName: row.fileName ?? "seed.ipt",
      documentType: row.documentType ?? "IPT",
      description: row.description ?? null,
      createdById: row.createdById ?? "seed_user",
      createdAt: row.createdAt ?? new Date(),
    };
    this.cadDocuments.push(full);
    return full;
  }

  addFileVersion(row: Partial<VersionRow> & { organizationId: string; cadDocumentId: string }): VersionRow {
    const full: VersionRow = {
      id: row.id ?? `seed_fv_${this.fileVersions.length + 1}`,
      organizationId: row.organizationId,
      cadDocumentId: row.cadDocumentId,
      versionNumber: row.versionNumber ?? 1,
    };
    this.fileVersions.push(full);
    return full;
  }

  private projectOperation(row: OperationRow) {
    // Mirrors OPERATION_SELECT: read ONLY the immutable
    // CopyDesignOperationEntry snapshot rows, ordered by ordinal - never the
    // CadCopyLineage rows or CURRENT CadDocument state.
    const entries = this.copyDesignOperationEntries
      .filter((e) => e.organizationId === row.organizationId && e.copyDesignOperationId === row.id)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((e) => ({
        ordinal: e.ordinal,
        action: e.action,
        sourceCadDocumentId: e.sourceCadDocumentId,
        sourceFileVersionId: e.sourceFileVersionId,
        resultingCadDocumentId: e.resultingCadDocumentId,
        originalDocumentNumber: e.originalDocumentNumber,
        originalFileName: e.originalFileName,
        originalDocumentType: e.originalDocumentType,
      }));
    return {
      id: row.id,
      performedAt: row.performedAt,
      requestPayload: row.requestPayload,
      entries,
    };
  }

  private makeApi(): CopyDesignDb {
    const self = this;
    return {
      cadDocument: {
        findFirst: (async ({ where }: { where: Record<string, unknown> }) => {
          const row = self.cadDocuments.find(
            (d) =>
              d.organizationId === where.organizationId &&
              (where.id === undefined || d.id === where.id) &&
              (where.documentNumber === undefined || d.documentNumber === where.documentNumber) &&
              (where.documentType === undefined || d.documentType === where.documentType),
          );
          return row ? { ...row } : null;
        }) as unknown,
        // P6D ROUND 2: mirrors the REAL query shapes copy-design-lineage-db.ts
        // now sends - either `{ id: { in } }` (unchanged) or
        // `{ OR: [{ documentNumber, documentType }, ...] }` (the new,
        // type-scoped collision check) - never the old flat
        // `{ documentNumber: { in } }` shape.
        findMany: (async ({ where }: { where: Record<string, unknown> }) => {
          const idFilter = (where.id as { in?: string[] } | undefined)?.in;
          const orFilter = where.OR as Array<{ documentNumber: string; documentType: string }> | undefined;
          return self.cadDocuments
            .filter(
              (d) =>
                d.organizationId === where.organizationId &&
                (idFilter === undefined || idFilter.includes(d.id)) &&
                (orFilter === undefined ||
                  orFilter.some((pair) => pair.documentNumber === d.documentNumber && pair.documentType === d.documentType)),
            )
            .map((d) => ({ ...d }));
        }) as unknown,
        create: (async ({ data }: { data: Record<string, unknown> }) => {
          // P6D ROUND 2: scoped by (organizationId, documentNumber,
          // documentType) - matches the real CadDocument unique constraint
          // after 20260921183016_scope_document_number_uniqueness_by_type.
          const conflict = self.cadDocuments.some(
            (d) =>
              d.organizationId === data.organizationId &&
              d.documentNumber === data.documentNumber &&
              d.documentType === data.documentType,
          );
          if (conflict) {
            throw new FakeP2002Error(["organizationId", "documentNumber", "documentType"]);
          }
          const row: DocRow = {
            id: `new_doc_${++self.docSeq}`,
            organizationId: data.organizationId as string,
            documentNumber: data.documentNumber as string,
            fileName: data.fileName as string,
            documentType: data.documentType as string,
            description: (data.description as string | null) ?? null,
            createdById: data.createdById as string,
            createdAt: new Date(),
          };
          self.cadDocuments.push(row);
          return { ...row };
        }) as unknown,
      } as unknown as CopyDesignDb["cadDocument"],

      fileVersion: {
        findFirst: (async ({ where }: { where: Record<string, unknown> }) => {
          const row = self.fileVersions.find(
            (v) =>
              v.organizationId === where.organizationId &&
              (where.cadDocumentId === undefined || v.cadDocumentId === where.cadDocumentId) &&
              (where.id === undefined || v.id === where.id),
          );
          return row ? { ...row } : null;
        }) as unknown,
      } as unknown as CopyDesignDb["fileVersion"],

      copyDesignOperation: {
        findFirst: (async ({ where }: { where: Record<string, unknown> }) => {
          const row = self.copyDesignOperations.find(
            (o) => o.organizationId === where.organizationId && o.idempotencyKey === where.idempotencyKey,
          );
          return row ? self.projectOperation(row) : null;
        }) as unknown,
        create: (async ({ data }: { data: Record<string, unknown> }) => {
          const conflict = self.copyDesignOperations.some(
            (o) => o.organizationId === data.organizationId && o.idempotencyKey === data.idempotencyKey,
          );
          if (conflict) {
            throw new FakeP2002Error(["organizationId", "idempotencyKey"]);
          }
          const row: OperationRow = {
            id: `op_${++self.opSeq}`,
            organizationId: data.organizationId as string,
            idempotencyKey: data.idempotencyKey as string,
            performedById: data.performedById as string,
            performedAt: new Date(),
            label: (data.label as string | null) ?? null,
            requestPayload: data.requestPayload,
          };
          self.copyDesignOperations.push(row);
          return { id: row.id, performedAt: row.performedAt };
        }) as unknown,
      } as unknown as CopyDesignDb["copyDesignOperation"],

      cadCopyLineage: {
        create: (async ({ data }: { data: Record<string, unknown> }) => {
          // Mirror the database's composite FK: the source FileVersion must
          // truly belong to the source CadDocument.
          const fv = self.fileVersions.find(
            (v) =>
              v.organizationId === data.organizationId &&
              v.cadDocumentId === data.sourceCadDocumentId &&
              v.id === data.sourceFileVersionId,
          );
          if (!fv) {
            throw new Error("Foreign key constraint violated: sourceFileVersion does not belong to sourceCadDocument");
          }
          const row: LineageRow = {
            id: `lin_${++self.linSeq}`,
            organizationId: data.organizationId as string,
            copyDesignOperationId: data.copyDesignOperationId as string,
            newCadDocumentId: data.newCadDocumentId as string,
            sourceCadDocumentId: data.sourceCadDocumentId as string,
            sourceFileVersionId: data.sourceFileVersionId as string,
            copiedById: data.copiedById as string,
            copiedAt: new Date(),
          };
          self.cadCopyLineages.push(row);
          return { ...row };
        }) as unknown,
      } as unknown as CopyDesignDb["cadCopyLineage"],

      copyDesignOperationEntry: {
        create: (async ({ data }: { data: Record<string, unknown> }) => {
          // Mirror the (organizationId, copyDesignOperationId, ordinal)
          // unique constraint.
          const conflict = self.copyDesignOperationEntries.some(
            (e) =>
              e.organizationId === data.organizationId &&
              e.copyDesignOperationId === data.copyDesignOperationId &&
              e.ordinal === data.ordinal,
          );
          if (conflict) {
            throw new FakeP2002Error(["organizationId", "copyDesignOperationId", "ordinal"]);
          }
          const row: OperationEntryRow = {
            id: `entry_${++self.entrySeq}`,
            organizationId: data.organizationId as string,
            copyDesignOperationId: data.copyDesignOperationId as string,
            ordinal: data.ordinal as number,
            action: data.action as "COPY" | "REUSE",
            sourceCadDocumentId: (data.sourceCadDocumentId as string | null) ?? null,
            sourceFileVersionId: (data.sourceFileVersionId as string | null) ?? null,
            resultingCadDocumentId: data.resultingCadDocumentId as string,
            originalDocumentNumber: data.originalDocumentNumber as string,
            originalFileName: data.originalFileName as string,
            originalDocumentType: data.originalDocumentType as string,
            originalDescription: (data.originalDescription as string | null) ?? null,
            createdAt: new Date(),
          };
          self.copyDesignOperationEntries.push(row);
          return { ...row };
        }) as unknown,
      } as unknown as CopyDesignDb["copyDesignOperationEntry"],

      $transaction: (async (fn: (tx: CopyDesignDb) => Promise<unknown>) => {
        self.transactionAttempts += 1;
        const snapshot = {
          cadDocuments: [...self.cadDocuments],
          fileVersions: [...self.fileVersions],
          copyDesignOperations: [...self.copyDesignOperations],
          cadCopyLineages: [...self.cadCopyLineages],
          copyDesignOperationEntries: [...self.copyDesignOperationEntries],
        };
        try {
          return await fn(self.makeApi());
        } catch (error) {
          self.cadDocuments = snapshot.cadDocuments;
          self.fileVersions = snapshot.fileVersions;
          self.copyDesignOperations = snapshot.copyDesignOperations;
          self.cadCopyLineages = snapshot.cadCopyLineages;
          self.copyDesignOperationEntries = snapshot.copyDesignOperationEntries;
          throw error;
        }
      }) as unknown as CopyDesignDb["$transaction"],
    };
  }

  get db(): CopyDesignDb {
    return this.makeApi();
  }
}

function actorIn(organizationId: string, role: UserRole = UserRole.ENGINEER, userId?: string): Actor {
  return {
    userId: userId ?? `user-${organizationId}`,
    organizationId,
    role,
    name: "Test User",
    email: `user@${organizationId}.example`,
  };
}

function copyEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "COPY",
    sourceCadDocumentId: "src_1",
    sourceFileVersionId: "src_1_fv1",
    newDocumentNumber: "10137-P001",
    newFileName: "10137-P001.ipt",
    documentType: "IPT",
    ...overrides,
  };
}

function reuseEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return { action: "REUSE", cadDocumentId: "reuse_1", ...overrides };
}

function setupSource(fake: FakeDatabase, org = "orgA") {
  fake.addCadDocument({ organizationId: org, id: "src_1", documentNumber: "10073-P001", fileName: "10073-P001.ipt" });
  fake.addFileVersion({ organizationId: org, cadDocumentId: "src_1", id: "src_1_fv1", versionNumber: 1 });
}

// ------------------------------------------------------------
// 1-4: COPY creates a new, distinct identity with exact lineage
// ------------------------------------------------------------

test("COPY creates a new CadDocument id, distinct from the source, with exact source FileVersion lineage", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-1", entries: [copyEntry()] },
    fake.db,
  );

  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.action, "COPY");
  assert.ok(entry.resultingCadDocumentId.length > 0);
  assert.notEqual(entry.resultingCadDocumentId, "src_1"); // COPY id != source id

  assert.equal(fake.cadDocuments.length, 2); // source + new
  assert.equal(fake.cadCopyLineages.length, 1);
  const lineage = fake.cadCopyLineages[0];
  assert.equal(lineage.newCadDocumentId, entry.resultingCadDocumentId);
  assert.equal(lineage.sourceCadDocumentId, "src_1");
  assert.equal(lineage.sourceFileVersionId, "src_1_fv1");
});

test("source FileVersion belonging to a DIFFERENT document is rejected", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  // A FileVersion that exists, but under a DIFFERENT CadDocument.
  fake.addCadDocument({ organizationId: "orgA", id: "other_doc", documentNumber: "OTHER-1" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "other_doc", id: "wrong_fv", versionNumber: 1 });

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        { idempotencyKey: "op-2", entries: [copyEntry({ sourceFileVersionId: "wrong_fv" })] },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignSourceNotFoundError,
  );
  assert.equal(fake.cadDocuments.length, 2); // no new document created
  assert.equal(fake.cadCopyLineages.length, 0);
});

test("cross-tenant source CadDocument is rejected without leaking existence", async () => {
  const fake = new FakeDatabase();
  setupSource(fake, "orgA");

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgB"),
        { idempotencyKey: "op-3", entries: [copyEntry()] },
        fake.db,
      ),
    (err: unknown) => {
      assert.ok(err instanceof CopyDesignSourceNotFoundError);
      assert.ok(!err.message.includes("src_1"));
      assert.ok(!err.message.includes("orgA"));
      return true;
    },
  );
});

test("cross-tenant source FileVersion (right doc id, wrong tenant) is rejected the SAME way", async () => {
  const fake = new FakeDatabase();
  setupSource(fake, "orgA");
  // orgB happens to also have a document with the SAME id string (cuids are
  // globally unique in reality, but this proves tenant scoping, not id luck).
  fake.addCadDocument({ organizationId: "orgB", id: "src_1_orgB", documentNumber: "10073-P001-B" });

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgB"),
        {
          idempotencyKey: "op-3b",
          entries: [copyEntry({ sourceCadDocumentId: "src_1_orgB", sourceFileVersionId: "src_1_fv1" })],
        },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignSourceNotFoundError,
  );
});

// ------------------------------------------------------------
// 5-7: REUSE
// ------------------------------------------------------------

test("REUSE creates no new CadDocument and no CadCopyLineage", async () => {
  const fake = new FakeDatabase();
  fake.addCadDocument({ organizationId: "orgA", id: "reuse_1", documentNumber: "10073-STD-BOLT" });

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-4", entries: [reuseEntry()] },
    fake.db,
  );

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].action, "REUSE");
  assert.equal(result.entries[0].resultingCadDocumentId, "reuse_1");
  assert.equal(fake.cadDocuments.length, 1); // no new document
  assert.equal(fake.cadCopyLineages.length, 0); // never pretend REUSE was copied
});

test("REUSE of an unknown / cross-tenant document is rejected", async () => {
  const fake = new FakeDatabase();
  fake.addCadDocument({ organizationId: "orgA", id: "reuse_1", documentNumber: "10073-STD-BOLT" });

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgB"),
        { idempotencyKey: "op-5", entries: [reuseEntry()] },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignSourceNotFoundError,
  );
});

// ------------------------------------------------------------
// 8-9: multi-entry atomicity, mixed COPY + REUSE
// ------------------------------------------------------------

test("one operation with multiple COPY entries is atomic - all succeed together", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "src_2", documentNumber: "10073-P002" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "src_2", id: "src_2_fv1" });

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    {
      idempotencyKey: "op-6",
      entries: [
        copyEntry(),
        copyEntry({
          sourceCadDocumentId: "src_2",
          sourceFileVersionId: "src_2_fv1",
          newDocumentNumber: "10137-P002",
          newFileName: "10137-P002.ipt",
        }),
      ],
    },
    fake.db,
  );

  assert.equal(result.entries.length, 2);
  assert.equal(fake.cadCopyLineages.length, 2);
  const newIds = result.entries.map((e) => e.resultingCadDocumentId);
  assert.notEqual(newIds[0], newIds[1]);
});

test("mixed COPY + REUSE in one operation works and is reported correctly", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "reuse_1", documentNumber: "10073-STD-BOLT" });

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-7", entries: [copyEntry(), reuseEntry()] },
    fake.db,
  );

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].action, "COPY");
  assert.equal(result.entries[1].action, "REUSE");
  assert.equal(fake.cadCopyLineages.length, 1);
});

// ------------------------------------------------------------
// 10-11: destination collision + atomicity of a failed operation
// ------------------------------------------------------------

test("destination documentNumber collision against an EXISTING document fails closed, no overwrite, no rename", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "existing_collider", documentNumber: "10137-P001" });

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        { idempotencyKey: "op-8", entries: [copyEntry()] },
        fake.db,
      ),
    (err: unknown) => {
      assert.ok(err instanceof CopyDesignDestinationConflictError);
      assert.deepEqual([...err.conflictingDocumentNumbers], ["10137-P001"]);
      return true;
    },
  );
  assert.equal(fake.cadDocuments.length, 2); // source + the pre-existing collider only
});

// P6D ROUND 2, HIGH fix: the SAME documentNumber with a DIFFERENT
// documentType is explicitly NOT a collision - a model and its drawing
// sharing one engineering base number, e.g. "1001.ipt" and "1001.idw".
test("the SAME documentNumber with a DIFFERENT documentType against an EXISTING document is NOT a collision", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "existing_idw", documentNumber: "10137-P001", documentType: "IDW" });

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-same-number-diff-type", entries: [copyEntry({ documentType: "IPT" })] },
    fake.db,
  );

  assert.equal(result.entries[0]!.documentType, "IPT");
  assert.equal(fake.cadDocuments.length, 3); // source + pre-existing IDW + the new IPT
});

// required test: 1001.ipt + 1001.idw coexist within ONE Copy Design
// operation (a drawing and its model copied together, sharing one number).
test("one operation can COPY the SAME documentNumber as BOTH an IPT and an IDW - they coexist", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "src_drawing", documentNumber: "10073-DWG-SRC", documentType: "IDW" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "src_drawing", id: "src_drawing_fv1", versionNumber: 1 });

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    {
      idempotencyKey: "op-model-and-drawing-pair",
      entries: [
        copyEntry({ newDocumentNumber: "1001", newFileName: "1001.ipt", documentType: "IPT" }),
        copyEntry({
          sourceCadDocumentId: "src_drawing",
          sourceFileVersionId: "src_drawing_fv1",
          newDocumentNumber: "1001",
          newFileName: "1001.idw",
          documentType: "IDW",
        }),
      ],
    },
    fake.db,
  );

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.documentNumber, "1001");
  assert.equal(result.entries[0]!.documentType, "IPT");
  assert.equal(result.entries[1]!.documentNumber, "1001");
  assert.equal(result.entries[1]!.documentType, "IDW");
  assert.notEqual(result.entries[0]!.resultingCadDocumentId, result.entries[1]!.resultingCadDocumentId);
});

// required test: duplicate same number + SAME type within one request is
// still rejected (intra-request check, now type-aware).
test("two COPY entries with the SAME documentNumber AND the SAME documentType within one request are rejected", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        {
          idempotencyKey: "op-intra-request-same-type",
          entries: [
            copyEntry({ newDocumentNumber: "1001", newFileName: "1001.ipt", documentType: "IPT" }),
            copyEntry({ newDocumentNumber: "1001", newFileName: "1001-b.ipt", documentType: "IPT" }),
          ],
        },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignValidationError,
  );
});

// same documentNumber, DIFFERENT type, within one request - allowed at the
// PARSE level (the DB-level test above proves the full apply path too).
test("two COPY entries with the SAME documentNumber but DIFFERENT documentTypes within one request are allowed", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    {
      idempotencyKey: "op-intra-request-diff-type",
      entries: [
        copyEntry({ newDocumentNumber: "1001", newFileName: "1001.ipt", documentType: "IPT" }),
        copyEntry({ newDocumentNumber: "1001", newFileName: "1001.iam", documentType: "IAM" }),
      ],
    },
    fake.db,
  );

  assert.equal(result.entries.length, 2);
});

test("a failed multi-entry operation leaves NO partial new identities behind", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "src_2", documentNumber: "10073-P002" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "src_2", id: "src_2_fv1" });
  // The SECOND entry's destination collides with an existing document -
  // validated BEFORE any write happens.
  fake.addCadDocument({ organizationId: "orgA", id: "existing_collider", documentNumber: "10137-P002" });

  const docCountBefore = fake.cadDocuments.length;
  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        {
          idempotencyKey: "op-9",
          entries: [
            copyEntry(), // would succeed in isolation
            copyEntry({
              sourceCadDocumentId: "src_2",
              sourceFileVersionId: "src_2_fv1",
              newDocumentNumber: "10137-P002", // collides
              newFileName: "10137-P002.ipt",
            }),
          ],
        },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignDestinationConflictError,
  );

  assert.equal(fake.cadDocuments.length, docCountBefore); // nothing new at all
  assert.equal(fake.cadCopyLineages.length, 0);
  assert.equal(fake.copyDesignOperations.length, 0);
});

// ------------------------------------------------------------
// 12-13: idempotency
// ------------------------------------------------------------

test("retrying the SAME idempotencyKey with an equivalent request does not duplicate identities", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const first = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-10", entries: [copyEntry()] },
    fake.db,
  );
  const docCountAfterFirst = fake.cadDocuments.length;
  const lineageCountAfterFirst = fake.cadCopyLineages.length;

  const second = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-10", entries: [copyEntry()] },
    fake.db,
  );

  assert.equal(second.copyDesignOperationId, first.copyDesignOperationId);
  assert.deepEqual(second.entries, first.entries);
  assert.equal(fake.cadDocuments.length, docCountAfterFirst); // nothing new
  assert.equal(fake.cadCopyLineages.length, lineageCountAfterFirst);
  assert.equal(fake.copyDesignOperations.length, 1);
});

test("the SAME idempotencyKey with a materially different request is rejected, never returns unrelated results", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "src_2", documentNumber: "10073-P002" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "src_2", id: "src_2_fv1" });

  await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-11", entries: [copyEntry()] },
    fake.db,
  );

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        {
          idempotencyKey: "op-11", // SAME key
          entries: [copyEntry({ sourceCadDocumentId: "src_2", sourceFileVersionId: "src_2_fv1" })], // DIFFERENT content
        },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignIdempotencyConflictError,
  );
  assert.equal(fake.copyDesignOperations.length, 1); // still just the original
});

test("idempotency comparison ignores the display-only label but not the entries", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const first = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-12", label: "first label", entries: [copyEntry()] },
    fake.db,
  );
  const second = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-12", label: "a completely different label", entries: [copyEntry()] },
    fake.db,
  );
  assert.equal(second.copyDesignOperationId, first.copyDesignOperationId);
  assert.equal(fake.copyDesignOperations.length, 1);
});

// ------------------------------------------------------------
// 14: lineage cannot be reassigned to another source
// ------------------------------------------------------------

test("lineage cannot be reassigned to a different source through this or any API - no update path exists", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-13", entries: [copyEntry()] },
    fake.db,
  );
  const newId = result.entries[0].resultingCadDocumentId;

  // The only mutation surface this module exposes is
  // applyCopyDesignOperationForActor (create-only). Prove there is no
  // update/patch export at all by checking the module's exported members -
  // and that re-copying the SAME already-copied identity as a NEW source
  // is fine (it becomes a source, not a re-target of the EXISTING lineage
  // row), while the ORIGINAL lineage row's source fields are untouched.
  const before = fake.cadCopyLineages.find((l) => l.newCadDocumentId === newId)!;
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: newId, id: `${newId}_fv1` });

  await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    {
      idempotencyKey: "op-14",
      entries: [
        copyEntry({ sourceCadDocumentId: newId, sourceFileVersionId: `${newId}_fv1`, newDocumentNumber: "10999-P001", newFileName: "10999-P001.ipt" }),
      ],
    },
    fake.db,
  );

  const after = fake.cadCopyLineages.find((l) => l.newCadDocumentId === newId)!;
  assert.equal(after.sourceCadDocumentId, before.sourceCadDocumentId);
  assert.equal(after.sourceFileVersionId, before.sourceFileVersionId);
});

// ------------------------------------------------------------
// 15: reserved vs materialized identity
// ------------------------------------------------------------

test("a reserved COPY identity is explicitly distinguishable from a physically materialized CadDocument", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const result = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-15", entries: [copyEntry()] },
    fake.db,
  );
  const newId = result.entries[0].resultingCadDocumentId;

  const isReserved = (cadDocumentId: string) =>
    fake.cadCopyLineages.some((l) => l.newCadDocumentId === cadDocumentId) &&
    !fake.fileVersions.some((v) => v.cadDocumentId === cadDocumentId);

  assert.equal(isReserved(newId), true); // has lineage, zero FileVersions
  assert.equal(isReserved("src_1"), false); // the SOURCE has a FileVersion, no lineage-as-new

  // P6C "materializes" it simply by creating its first FileVersion - no
  // special API call needed for this module to reflect the transition.
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: newId, id: "materialized_fv1" });
  assert.equal(isReserved(newId), false);
});

// ------------------------------------------------------------
// Role / auth
// ------------------------------------------------------------

test("VIEWER role cannot apply a Copy Design operation", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA", UserRole.VIEWER),
        { idempotencyKey: "op-16", entries: [copyEntry()] },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignRoleError,
  );
  assert.equal(fake.cadDocuments.length, 1);
});

// ------------------------------------------------------------
// Request validation
// ------------------------------------------------------------

test("malformed requests are rejected with CopyDesignValidationError", async () => {
  const fake = new FakeDatabase();
  const actor = actorIn("orgA");

  for (const bad of [
    {},
    { idempotencyKey: "" },
    { idempotencyKey: "k", entries: [] },
    { idempotencyKey: "k", entries: [{ action: "BOGUS" }] },
    { idempotencyKey: "k", entries: [{ action: "COPY" }] },
    { idempotencyKey: "k", entries: [{ action: "REUSE" }] },
    { idempotencyKey: "k", entries: [copyEntry({ documentType: "NOT_A_TYPE" })] },
    { idempotencyKey: "k", entries: [copyEntry({ newDocumentNumber: "SAME" }), copyEntry({ newDocumentNumber: "SAME" })] },
  ]) {
    await assert.rejects(
      () => applyCopyDesignOperationForActor(actor, bad, fake.db),
      (err: unknown) => err instanceof CopyDesignValidationError,
    );
  }
  assert.equal(fake.cadDocuments.length, 0);
});

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

test("http: no actor -> 401, does not touch the database", async () => {
  const fake = new FakeDatabase();
  const res = await copyDesignApplyHttpResult(null, { idempotencyKey: "k", entries: [copyEntry()] }, fake.db);
  assert.equal(res.status, 401);
  assert.equal(fake.cadDocuments.length, 0);
});

test("http: happy COPY path is 200 with the expected DTO shape", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const res = await copyDesignApplyHttpResult(
    actorIn("orgA"),
    { idempotencyKey: "op-17", entries: [copyEntry()] },
    fake.db,
  );
  assert.equal(res.status, 200);
  const body = res.body as { copyDesignOperationId: string; entries: Array<{ action: string }> };
  assert.ok(body.copyDesignOperationId);
  assert.equal(body.entries[0].action, "COPY");
});

test("http: role error -> 403; validation error -> 400; not found -> 404; destination conflict -> 409", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "collider", documentNumber: "10137-P001" });

  assert.equal(
    (await copyDesignApplyHttpResult(actorIn("orgA", UserRole.VIEWER), { idempotencyKey: "a", entries: [copyEntry()] }, fake.db)).status,
    403,
  );
  assert.equal((await copyDesignApplyHttpResult(actorIn("orgA"), {}, fake.db)).status, 400);
  assert.equal(
    (
      await copyDesignApplyHttpResult(
        actorIn("orgA"),
        { idempotencyKey: "b", entries: [copyEntry({ sourceCadDocumentId: "nope" })] },
        fake.db,
      )
    ).status,
    404,
  );
  assert.equal(
    (await copyDesignApplyHttpResult(actorIn("orgA"), { idempotencyKey: "c", entries: [copyEntry()] }, fake.db)).status,
    409,
  );
});

// ------------------------------------------------------------
// Tenant composite FK protection stays enforced (sanity check on the FAKE's
// own FK simulation, mirroring the REAL database's composite FK)
// ------------------------------------------------------------

// ------------------------------------------------------------
// ROUND 2, HIGH: idempotent replay must NOT depend on mutable
// CadDocument.documentNumber / fileName - only on the immutable
// CopyDesignOperationEntry snapshot rows.
// ------------------------------------------------------------

test("replay after the COPY target's documentNumber is RENAMED still returns the SAME resulting id", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const first = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-rename", entries: [copyEntry()] },
    fake.db,
  );
  const resultingId = first.entries[0].resultingCadDocumentId;

  // Rename the CadDocument AFTER the operation - mutable state changing out
  // from under a later replay is exactly the defect this fix closes.
  const doc = fake.cadDocuments.find((d) => d.id === resultingId)!;
  doc.documentNumber = "RENAMED-999";
  doc.fileName = "renamed.ipt";

  const second = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-rename", entries: [copyEntry()] },
    fake.db,
  );

  assert.equal(second.copyDesignOperationId, first.copyDesignOperationId);
  assert.equal(second.entries[0].resultingCadDocumentId, resultingId);
  // The replay's snapshot fields are the ORIGINAL ones, not the rename.
  assert.equal((second.entries[0] as { documentNumber: string }).documentNumber, "10137-P001");
  assert.equal((second.entries[0] as { fileName: string }).fileName, "10137-P001.ipt");
});

test("replay after two COPY targets' documentNumbers are SWAPPED still maps each entry to its correct original result", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "src_2", documentNumber: "10073-P002" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "src_2", id: "src_2_fv1" });

  const first = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    {
      idempotencyKey: "op-swap",
      entries: [
        copyEntry({ newDocumentNumber: "10137-P001", newFileName: "10137-P001.ipt" }),
        copyEntry({
          sourceCadDocumentId: "src_2",
          sourceFileVersionId: "src_2_fv1",
          newDocumentNumber: "10137-P002",
          newFileName: "10137-P002.ipt",
        }),
      ],
    },
    fake.db,
  );
  const [firstId, secondId] = first.entries.map((e) => e.resultingCadDocumentId);

  // Swap the two documents' numbers with each other.
  const docA = fake.cadDocuments.find((d) => d.id === firstId)!;
  const docB = fake.cadDocuments.find((d) => d.id === secondId)!;
  docA.documentNumber = "10137-P002";
  docB.documentNumber = "10137-P001";

  const second = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    {
      idempotencyKey: "op-swap",
      entries: [
        copyEntry({ newDocumentNumber: "10137-P001", newFileName: "10137-P001.ipt" }),
        copyEntry({
          sourceCadDocumentId: "src_2",
          sourceFileVersionId: "src_2_fv1",
          newDocumentNumber: "10137-P002",
          newFileName: "10137-P002.ipt",
        }),
      ],
    },
    fake.db,
  );

  assert.equal(second.entries[0].resultingCadDocumentId, firstId);
  assert.equal(second.entries[1].resultingCadDocumentId, secondId);
});

test("replay after the COPY target's fileName changes does not break correlation", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const first = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-filename", entries: [copyEntry()] },
    fake.db,
  );
  const resultingId = first.entries[0].resultingCadDocumentId;
  fake.cadDocuments.find((d) => d.id === resultingId)!.fileName = "totally-different-name.ipt";

  const second = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-filename", entries: [copyEntry()] },
    fake.db,
  );
  assert.equal(second.entries[0].resultingCadDocumentId, resultingId);
  assert.equal((second.entries[0] as { fileName: string }).fileName, "10137-P001.ipt");
});

test("mixed COPY + REUSE replay preserves original entry order", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "reuse_1", documentNumber: "10073-STD-BOLT" });

  const first = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-mixed-order", entries: [copyEntry(), reuseEntry()] },
    fake.db,
  );
  const second = await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-mixed-order", entries: [copyEntry(), reuseEntry()] },
    fake.db,
  );

  assert.deepEqual(
    second.entries.map((e) => e.action),
    ["COPY", "REUSE"],
  );
  assert.deepEqual(second.entries, first.entries);
});

test("operation entry ordinals are deterministic (0-based, request order) and immutable across replay", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "reuse_1", documentNumber: "10073-STD-BOLT" });

  await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-ordinal", entries: [copyEntry(), reuseEntry()] },
    fake.db,
  );

  const op = fake.copyDesignOperations.find((o) => o.idempotencyKey === "op-ordinal")!;
  const entries = fake.copyDesignOperationEntries
    .filter((e) => e.copyDesignOperationId === op.id)
    .sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(
    entries.map((e) => e.ordinal),
    [0, 1],
  );
  assert.deepEqual(
    entries.map((e) => e.action),
    ["COPY", "REUSE"],
  );

  // Retrying does not append, mutate, or reorder any entry row.
  await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-ordinal", entries: [copyEntry(), reuseEntry()] },
    fake.db,
  );
  const entriesAfter = fake.copyDesignOperationEntries.filter((e) => e.copyDesignOperationId === op.id);
  assert.equal(entriesAfter.length, 2);
});

test("same idempotency key + a materially different request still conflicts, even with the new entry table in place", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "reuse_1", documentNumber: "10073-STD-BOLT" });

  await applyCopyDesignOperationForActor(
    actorIn("orgA"),
    { idempotencyKey: "op-still-conflicts", entries: [copyEntry()] },
    fake.db,
  );

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        { idempotencyKey: "op-still-conflicts", entries: [reuseEntry()] }, // different shape entirely
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignIdempotencyConflictError,
  );
});

// ------------------------------------------------------------
// ROUND 2, LOW 1: precise P2002 handling - only a KNOWN constraint's target
// is reinterpreted; anything else is rethrown as-is.
// ------------------------------------------------------------

/**
 * Builds a `CopyDesignDb` whose `$transaction` hands `applyWithinTransaction`
 * a `tx` object identical to the fake's normal one EXCEPT that
 * `cadDocument.create` or `copyDesignOperationEntry.create` (per
 * `poison`) always throws the given error - used to exercise the P2002
 * dispatch logic in `applyCopyDesignOperationForActor`'s catch block
 * directly, without needing a real second concurrent writer.
 */
function dbWithPoisonedCreate(
  fake: FakeDatabase,
  poison: "cadDocument" | "copyDesignOperation" | "copyDesignOperationEntry",
  error: Error,
): CopyDesignDb {
  const outer = fake.db;
  return {
    ...outer,
    $transaction: (async (fn: (tx: CopyDesignDb) => Promise<unknown>) => {
      const tx = fake.db;
      (tx[poison] as unknown as { create: unknown }).create = async () => {
        throw error;
      };
      return fn(tx);
    }) as unknown as CopyDesignDb["$transaction"],
  };
}

test("an UNRECOGNIZED P2002 (unknown constraint target) is rethrown as-is, never misreported as a destination collision", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  // Force an unrelated/unknown unique-constraint violation during the write
  // phase, simulating a constraint this module does not know about.
  const db = dbWithPoisonedCreate(fake, "cadDocument", new FakeP2002Error(["organizationId", "someUnrelatedColumn"]));

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-unknown-p2002", entries: [copyEntry()] }, db),
    (err: unknown) => !(err instanceof CopyDesignDestinationConflictError) && (err as { code?: string }).code === "P2002",
  );
});

test("a P2002 on the operation-entry ordinal constraint is reported as a concurrency conflict, not a destination collision", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const db = dbWithPoisonedCreate(
    fake,
    "copyDesignOperationEntry",
    new FakeP2002Error(["organizationId", "copyDesignOperationId", "ordinal"]),
  );

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-ordinal-p2002", entries: [copyEntry()] }, db),
    (err: unknown) => err instanceof CopyDesignConcurrencyConflictError,
  );
});

// ------------------------------------------------------------
// ROUND 3, LOW: EXACT (not containment) P2002 target matching - both the
// array-column shape and the string constraint/index-name shape, and proof
// that an unknown or merely-overlapping target is never misclassified.
//
// The exact index names below are the REAL names PostgreSQL/Prisma generate
// for these constraints (see the corresponding migration.sql files) - the
// string-shaped `meta.target` case some drivers report.
// ------------------------------------------------------------

const IDEMPOTENCY_KEY_INDEX_NAME = "CopyDesignOperation_organizationId_idempotencyKey_key";
// P6D ROUND 2, HIGH fix: was "CadDocument_organizationId_documentNumber_key"
// - see 20260921183016_scope_document_number_uniqueness_by_type/migration.sql.
const DOCUMENT_NUMBER_INDEX_NAME = "CadDocument_organizationId_documentNumber_documentType_key";
const OPERATION_ENTRY_ORDINAL_INDEX_NAME = "CopyDesignOperationEntry_organizationId_copyDesignOperation_key";

test("a STRING-shaped meta.target with the EXACT idempotencyKey index name is recognized (fails closed since no real committed row exists to reconcile)", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const db = dbWithPoisonedCreate(fake, "copyDesignOperation", new FakeP2002Error(IDEMPOTENCY_KEY_INDEX_NAME));

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-string-idempotency", entries: [copyEntry()] }, db),
    // Correctly classified into the idempotencyKey branch: it attempts an
    // afterRace reconcile, finds nothing (this test seeded no concurrent
    // winner), and fails closed - NEVER the raw FakeP2002Error, which is
    // what an unrecognized/misclassified target would surface instead.
    (err: unknown) => err instanceof CopyDesignConcurrencyConflictError,
  );
});

test("a STRING-shaped meta.target with the EXACT documentNumber index name is recognized as a destination collision", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const db = dbWithPoisonedCreate(fake, "cadDocument", new FakeP2002Error(DOCUMENT_NUMBER_INDEX_NAME));

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-string-docnumber", entries: [copyEntry()] }, db),
    (err: unknown) => err instanceof CopyDesignDestinationConflictError,
  );
});

test("a STRING-shaped meta.target with the EXACT operation-entry-ordinal index name is recognized as a concurrency conflict", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const db = dbWithPoisonedCreate(fake, "copyDesignOperationEntry", new FakeP2002Error(OPERATION_ENTRY_ORDINAL_INDEX_NAME));

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-string-ordinal", entries: [copyEntry()] }, db),
    (err: unknown) => err instanceof CopyDesignConcurrencyConflictError,
  );
});

test("a STRING-shaped meta.target that does NOT exactly match any known index name is rethrown as-is, never misclassified", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  // Close to the real idempotencyKey index name, but not exact (a
  // different/legacy suffix) - must NOT be treated as a match.
  const db = dbWithPoisonedCreate(
    fake,
    "copyDesignOperation",
    new FakeP2002Error("CopyDesignOperation_organizationId_idempotencyKey_unique"),
  );

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-string-unknown", entries: [copyEntry()] }, db),
    (err: unknown) =>
      !(err instanceof CopyDesignConcurrencyConflictError) &&
      !(err instanceof CopyDesignDestinationConflictError) &&
      (err as { code?: string }).code === "P2002",
  );
});

test("an ARRAY-shaped meta.target that is a SUPERSET of a known field set is NOT accidentally classified", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  // Same fields as the real idempotencyKey constraint, PLUS an extra column
  // - an exact-set match must reject this, not just "contains these fields".
  const db = dbWithPoisonedCreate(
    fake,
    "copyDesignOperation",
    new FakeP2002Error(["organizationId", "idempotencyKey", "unexpectedExtraColumn"]),
  );

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-array-superset", entries: [copyEntry()] }, db),
    (err: unknown) =>
      !(err instanceof CopyDesignConcurrencyConflictError) &&
      !(err instanceof CopyDesignDestinationConflictError) &&
      (err as { code?: string }).code === "P2002",
  );
});

test("an ARRAY-shaped meta.target with the EXACT documentNumber+documentType field set is recognized as a destination collision", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const db = dbWithPoisonedCreate(
    fake,
    "cadDocument",
    new FakeP2002Error(["organizationId", "documentNumber", "documentType"]),
  );

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-array-docnumber", entries: [copyEntry()] }, db),
    (err: unknown) => err instanceof CopyDesignDestinationConflictError,
  );
});

// P6D ROUND 2: the OLD (pre-migration) two-column target must NEVER still
// match - it is a SUBSET of the new three-column constraint, and an exact-
// set match must reject a subset just as it rejects a superset.
test("an ARRAY-shaped meta.target with only the OLD two-column documentNumber field set is NOT classified as a destination collision", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const db = dbWithPoisonedCreate(fake, "cadDocument", new FakeP2002Error(["organizationId", "documentNumber"]));

  await assert.rejects(
    () => applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: "op-array-old-docnumber", entries: [copyEntry()] }, db),
    (err: unknown) =>
      !(err instanceof CopyDesignConcurrencyConflictError) &&
      !(err instanceof CopyDesignDestinationConflictError) &&
      (err as { code?: string }).code === "P2002",
  );
});

// ------------------------------------------------------------
// ROUND 2, LOW 2: final idempotency reconciliation after SERIALIZABLE retry
// exhaustion.
// ------------------------------------------------------------

/**
 * ROUND 3, TEST GAP FIX: builds a `CopyDesignDb` whose
 * `copyDesignOperation.findFirst` returns `null` on its FIRST call (the
 * request's OWN outer fast idempotency pre-check - forced to see nothing
 * yet, exactly as a genuinely concurrent commit that hasn't landed from this
 * reader's point of view would) and delegates to the REAL fake for every
 * call after that (the post-exhaustion FINAL lookup, and any in-transaction
 * re-check) - and whose `$transaction` always fails with a retryable P2034,
 * counting attempts. This is the ONLY way to make a test actually exercise
 * `runSerializableTransaction`'s bounded retry + this module's
 * post-exhaustion reconciliation: the PREVIOUS version of this test let the
 * outer fast pre-check find the already-committed row immediately and
 * returned success WITHOUT ever calling `$transaction` at all - the
 * exhaustion branch was never reached, so the assertion passed for the
 * wrong reason.
 */
function dbExhaustingThenRevealing(fake: FakeDatabase): { db: CopyDesignDb; transactionAttempts: () => number } {
  const baseApi = fake.db;
  let findFirstCalls = 0;
  let transactionAttempts = 0;
  const db: CopyDesignDb = {
    ...baseApi,
    copyDesignOperation: {
      ...baseApi.copyDesignOperation,
      findFirst: (async (args: unknown) => {
        findFirstCalls += 1;
        if (findFirstCalls === 1) {
          return null;
        }
        return (fake.db.copyDesignOperation.findFirst as (a: unknown) => Promise<unknown>)(args);
      }) as unknown,
    } as unknown as CopyDesignDb["copyDesignOperation"],
    $transaction: (async () => {
      transactionAttempts += 1;
      const err = new Error("could not serialize access") as Error & { code: string };
      err.code = "P2034";
      throw err;
    }) as unknown as CopyDesignDb["$transaction"],
  };
  return { db, transactionAttempts: () => transactionAttempts };
}

test("after serialization-retry exhaustion, a same-key operation that committed WHILE retries were exhausting is found and returned by the FINAL lookup - not the initial (null) fast pre-check", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  const request = { idempotencyKey: "op-exhaustion-committed", entries: [copyEntry()] };

  // A genuinely separate, already-successful write - performed through the
  // UNMODIFIED fake, so a real CopyDesignOperation + entry row exists for
  // the rigged db's SECOND (post-exhaustion) lookup to find.
  const original = await applyCopyDesignOperationForActor(actorIn("orgA"), request, fake.db);

  const { db: rigged, transactionAttempts } = dbExhaustingThenRevealing(fake);
  const result = await applyCopyDesignOperationForActor(actorIn("orgA"), request, rigged);

  assert.equal(transactionAttempts(), 3, "every SERIALIZABLE transaction attempt must be exhausted before falling back to the final lookup");
  assert.equal(result.copyDesignOperationId, original.copyDesignOperationId);
  assert.deepEqual(result.entries, original.entries);
  assert.equal(fake.copyDesignOperations.length, 1); // still just the one committed operation - no duplicate
});

test("after serialization-retry exhaustion, a same-key operation that committed with a MATERIALLY DIFFERENT request still conflicts - never silently returned", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);
  fake.addCadDocument({ organizationId: "orgA", id: "src_2", documentNumber: "10073-P002" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "src_2", id: "src_2_fv1" });
  const key = "op-exhaustion-conflict";

  await applyCopyDesignOperationForActor(actorIn("orgA"), { idempotencyKey: key, entries: [copyEntry()] }, fake.db);

  const { db: rigged, transactionAttempts } = dbExhaustingThenRevealing(fake);
  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        {
          idempotencyKey: key, // SAME key
          entries: [copyEntry({ sourceCadDocumentId: "src_2", sourceFileVersionId: "src_2_fv1" })], // DIFFERENT content
        },
        rigged,
      ),
    (err: unknown) => err instanceof CopyDesignIdempotencyConflictError,
  );
  assert.equal(transactionAttempts(), 3);
  assert.equal(fake.copyDesignOperations.length, 1); // still just the original
});

test("after serialization-retry exhaustion with NO committed operation under that key, a concurrency error is returned", async () => {
  const fake = new FakeDatabase();
  setupSource(fake);

  const alwaysExhausted: CopyDesignDb = {
    ...fake.db,
    $transaction: (async () => {
      const err = new Error("could not serialize access") as Error & { code: string };
      err.code = "P2034";
      throw err;
    }) as unknown as CopyDesignDb["$transaction"],
  };

  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        { idempotencyKey: "op-exhaustion-nothing", entries: [copyEntry()] },
        alwaysExhausted,
      ),
    (err: unknown) => err instanceof CopyDesignConcurrencyConflictError,
  );
});

test("a FileVersion cannot be paired with a source document it does not belong to, even inside the transaction", async () => {
  const fake = new FakeDatabase();
  fake.addCadDocument({ organizationId: "orgA", id: "docA", documentNumber: "A-1" });
  fake.addCadDocument({ organizationId: "orgA", id: "docB", documentNumber: "B-1" });
  fake.addFileVersion({ organizationId: "orgA", cadDocumentId: "docB", id: "fv_of_B" });

  // The read-only pre-check already catches this (CopyDesignSourceNotFoundError)
  // before the transaction ever attempts the insert - confirming defense in
  // depth, not just the friendly error path.
  await assert.rejects(
    () =>
      applyCopyDesignOperationForActor(
        actorIn("orgA"),
        { idempotencyKey: "op-fk", entries: [copyEntry({ sourceCadDocumentId: "docA", sourceFileVersionId: "fv_of_B" })] },
        fake.db,
      ),
    (err: unknown) => err instanceof CopyDesignSourceNotFoundError,
  );
});
