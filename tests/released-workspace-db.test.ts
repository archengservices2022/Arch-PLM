/**
 * Focused tests for Released Revision retrieval
 * (`app/lib/released-workspace-db.ts`, P3D-2).
 *
 * Run with:  node --experimental-strip-types --test tests/released-workspace-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LifecycleState, UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import {
  ItemRevisionNotFoundError,
  ReleaseBaselineMissingError,
  ReleasedBinaryIntegrityError,
  RevisionNotReleasedError,
  getReleasedWorkspacePlanForActor,
  getReleasedWorkspaceHttpResult,
  type ReleasedWorkspaceDb,
} from "../app/lib/released-workspace-db.ts";
import {
  RELEASED_WORKSPACE_CONTRACT_ID,
} from "../app/lib/released-workspace-core.ts";

// ------------------------------------------------------------
// Fake database + storage
// ------------------------------------------------------------

interface RevisionRow {
  organizationId: string;
  id: string;
  lifecycle: string;
}
interface BaselineRow {
  organizationId: string;
  id: string;
  itemRevisionId: string;
  createdAt: Date;
  createdById: string;
}
interface EntryRow {
  organizationId: string;
  id: string;
  releaseBaselineId: string;
  cadDocumentId: string;
  fileVersionId: string;
}
interface DocRow {
  organizationId: string;
  id: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
}
interface VersionRow {
  organizationId: string;
  id: string;
  cadDocumentId: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: bigint | null;
  storageKey: string;
  originalFileName: string;
}

class FakeDatabase {
  readonly revisions: RevisionRow[] = [];
  readonly baselines: BaselineRow[] = [];
  readonly entries: EntryRow[] = [];
  readonly docs: DocRow[] = [];
  readonly versions: VersionRow[] = [];
  /** storageKey -> the bytes the storage layer would report for that object.
   *  Absent key = no stored object (hashObject throws, like the real
   *  provider on a missing file). Defaults to matching the FileVersion row's
   *  own checksum/fileSize; corruption tests pass `storedAs` to diverge. */
  readonly storageObjects = new Map<string, { sha256: string; size: number }>();

  addRevision(row: RevisionRow): this {
    this.revisions.push(row);
    return this;
  }
  addBaseline(row: Omit<BaselineRow, "createdAt"> & { createdAt?: Date }): this {
    this.baselines.push({ createdAt: new Date(), ...row });
    return this;
  }
  addEntry(row: EntryRow): this {
    this.entries.push(row);
    return this;
  }
  addDoc(row: DocRow): this {
    this.docs.push(row);
    return this;
  }
  addVersion(
    row: Omit<VersionRow, "fileSize"> & { fileSize: number | null },
    present = true,
    storedAs?: { sha256?: string; size?: number },
  ): this {
    this.versions.push({ ...row, fileSize: row.fileSize == null ? null : BigInt(row.fileSize) });
    if (present) {
      this.storageObjects.set(row.storageKey, {
        sha256: storedAs?.sha256 ?? row.checksum ?? "",
        size: storedAs?.size ?? (row.fileSize == null ? 0 : row.fileSize),
      });
    }
    return this;
  }

  get provider() {
    const self = this;
    return {
      async hashObject(key: string): Promise<{ sha256: string; size: number }> {
        const obj = self.storageObjects.get(key);
        if (!obj) {
          // Mirror the real provider raising on an absent/unreadable object.
          throw new Error("storage object not found");
        }
        return { sha256: obj.sha256, size: obj.size };
      },
    };
  }

  get db(): ReleasedWorkspaceDb {
    const self = this;
    return {
      itemRevision: {
        findFirst: (async (args: { where: { id: string; organizationId: string } }) => {
          const row = self.revisions.find(
            (r) => r.id === args.where.id && r.organizationId === args.where.organizationId,
          );
          return row ? { id: row.id, lifecycle: row.lifecycle } : null;
        }) as unknown as ReleasedWorkspaceDb["itemRevision"]["findFirst"],
      } as unknown as ReleasedWorkspaceDb["itemRevision"],
      releaseBaseline: {
        findFirst: (async (args: {
          where: { organizationId: string; itemRevisionId: string };
        }) => {
          const row = self.baselines.find(
            (b) =>
              b.organizationId === args.where.organizationId &&
              b.itemRevisionId === args.where.itemRevisionId,
          );
          return row ? { id: row.id, createdAt: row.createdAt, createdById: row.createdById } : null;
        }) as unknown as ReleasedWorkspaceDb["releaseBaseline"]["findFirst"],
      } as unknown as ReleasedWorkspaceDb["releaseBaseline"],
      releaseBaselineEntry: {
        findMany: (async (args: {
          where: { organizationId: string; releaseBaselineId: string };
          orderBy: Array<{ cadDocumentId?: "asc" | "desc"; id?: "asc" | "desc" }>;
        }) => {
          const rows = self.entries
            .filter(
              (e) =>
                e.organizationId === args.where.organizationId &&
                e.releaseBaselineId === args.where.releaseBaselineId,
            )
            .sort((a, b) => {
              for (const clause of args.orderBy) {
                if (clause.cadDocumentId) {
                  const diff = a.cadDocumentId.localeCompare(b.cadDocumentId);
                  if (diff !== 0) return clause.cadDocumentId === "desc" ? -diff : diff;
                }
                if (clause.id) {
                  const diff = a.id.localeCompare(b.id);
                  if (diff !== 0) return clause.id === "desc" ? -diff : diff;
                }
              }
              return 0;
            });
          return rows.map((e) => {
            const doc = self.docs.find(
              (d) => d.id === e.cadDocumentId && d.organizationId === e.organizationId,
            );
            const version = self.versions.find(
              (v) => v.id === e.fileVersionId && v.organizationId === e.organizationId,
            );
            return {
              cadDocumentId: e.cadDocumentId,
              fileVersionId: e.fileVersionId,
              cadDocument: doc
                ? { documentNumber: doc.documentNumber, fileName: doc.fileName, documentType: doc.documentType }
                : null,
              fileVersion: version
                ? {
                    id: version.id,
                    cadDocumentId: version.cadDocumentId,
                    versionNumber: version.versionNumber,
                    checksum: version.checksum,
                    fileSize: version.fileSize,
                    storageKey: version.storageKey,
                    originalFileName: version.originalFileName,
                  }
                : null,
            };
          });
        }) as unknown as ReleasedWorkspaceDb["releaseBaselineEntry"]["findMany"],
      } as unknown as ReleasedWorkspaceDb["releaseBaselineEntry"],
    } as unknown as ReleasedWorkspaceDb;
  }
}

function actorIn(organizationId: string, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role: UserRole.ENGINEER,
    name: "Test User",
    email: `user@${organizationId}.example`,
    ...overrides,
  };
}

/** Seeds a RELEASED revision with a baseline pinning V1 for doc-1, while V2
 *  also exists (the "later version exists" scenario from the task). */
function seedReleasedRevisionPinningV1(db: FakeDatabase): { revisionId: string; baselineId: string } {
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "assembly.iam", documentType: "IAM" });
  db.addVersion({
    organizationId: "orgA",
    id: "fv-1-v1",
    cadDocumentId: "doc-1",
    versionNumber: 1,
    checksum: "checksum-v1",
    fileSize: 100,
    storageKey: "org/orgA/doc/doc-1/v1/aaa",
    originalFileName: "assembly.iam",
  });
  // Later version exists too - must NEVER be what's returned.
  db.addVersion({
    organizationId: "orgA",
    id: "fv-1-v2",
    cadDocumentId: "doc-1",
    versionNumber: 2,
    checksum: "checksum-v2",
    fileSize: 200,
    storageKey: "org/orgA/doc/doc-1/v2/bbb",
    originalFileName: "assembly.iam",
  });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  return { revisionId: "rev-1", baselineId: "rb-1" };
}

// ------------------------------------------------------------
// 1. Pins V1, later V2 exists -> retrieval returns V1 only
// ------------------------------------------------------------

test("released revision pinning V1 with a later V2 present: retrieval returns V1 only, never V2", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db);
  const actor = actorIn("orgA");

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.version!.fileVersionId, "fv-1-v1");
  assert.equal(plan.entries[0]!.version!.versionNumber, 1);
  assert.notEqual(plan.entries[0]!.version!.fileVersionId, "fv-1-v2");
});

// ------------------------------------------------------------
// 2. Multiple baseline entries -> all exact pinned FileVersions returned
// ------------------------------------------------------------

test("multiple baseline entries: every exact pinned FileVersion is returned", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  for (const [doc, ver] of [["doc-assembly", 5], ["doc-frame", 8], ["doc-drawing", 4]] as const) {
    db.addDoc({ organizationId: "orgA", id: doc, documentNumber: doc.toUpperCase(), fileName: `${doc}.ipt`, documentType: "IPT" });
    db.addVersion({
      organizationId: "orgA",
      id: `fv-${doc}-v${ver}`,
      cadDocumentId: doc,
      versionNumber: ver,
      checksum: `checksum-${doc}`,
      fileSize: 100,
      storageKey: `org/orgA/doc/${doc}/v${ver}/x`,
      originalFileName: `${doc}.ipt`,
    });
    db.addEntry({ organizationId: "orgA", id: `rbe-${doc}`, releaseBaselineId: "rb-1", cadDocumentId: doc, fileVersionId: `fv-${doc}-v${ver}` });
  }
  const actor = actorIn("orgA");

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);
  assert.equal(plan.entries.length, 3);
  const byDoc = new Map(plan.entries.map((e) => [e.cadDocumentId, e.version!.versionNumber]));
  assert.equal(byDoc.get("doc-assembly"), 5);
  assert.equal(byDoc.get("doc-frame"), 8);
  assert.equal(byDoc.get("doc-drawing"), 4);
});

// ------------------------------------------------------------
// 3. Exact contentPath uses pinned FileVersion ID
// ------------------------------------------------------------

test("contentPath is exactly the authenticated content endpoint for the pinned FileVersion ID", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db);
  const actor = actorIn("orgA");

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);
  assert.equal(plan.entries[0]!.version!.contentPath, "/api/file-versions/fv-1-v1/content");
});

// ------------------------------------------------------------
// 4. Missing pinned binary -> controlled failure, no fallback
// ------------------------------------------------------------

test("missing pinned binary: controlled failure, never falls back to a newer or older version", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "part.ipt", documentType: "IPT" });
  // V1 pinned but its binary was removed from storage (present=false).
  db.addVersion(
    { organizationId: "orgA", id: "fv-1-v1", cadDocumentId: "doc-1", versionNumber: 1, checksum: "c1", fileSize: 100, storageKey: "org/orgA/doc/doc-1/v1/x", originalFileName: "part.ipt" },
    false,
  );
  // A newer version DOES exist and IS present - must never be substituted.
  db.addVersion({ organizationId: "orgA", id: "fv-1-v2", cadDocumentId: "doc-1", versionNumber: 2, checksum: "c2", fileSize: 200, storageKey: "org/orgA/doc/doc-1/v2/y", originalFileName: "part.ipt" });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleasedBinaryIntegrityError);
      assert.equal(error.reason, "missing-binary");
      assert.equal(error.fileVersionId, "fv-1-v1", "must report the problem against the PINNED version, never V2");
      return true;
    },
  );

  const httpResult = await getReleasedWorkspaceHttpResult(actor, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 422);
});

// ------------------------------------------------------------
// 5. Missing checksum/fileSize -> controlled integrity failure
// ------------------------------------------------------------

test("missing checksum/fileSize on the pinned FileVersion: controlled integrity failure", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "part.ipt", documentType: "IPT" });
  db.addVersion({ organizationId: "orgA", id: "fv-1-v1", cadDocumentId: "doc-1", versionNumber: 1, checksum: null, fileSize: null, storageKey: "org/orgA/doc/doc-1/v1/x", originalFileName: "part.ipt" });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleasedBinaryIntegrityError);
      assert.equal(error.reason, "missing-metadata");
      return true;
    },
  );
});

// ------------------------------------------------------------
// 6. RELEASED revision with no baseline -> controlled integrity failure
// ------------------------------------------------------------

test("RELEASED revision with no ReleaseBaseline row: controlled integrity failure, never falls back to ItemRevisionDocument", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  // No baseline seeded at all.
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    ReleaseBaselineMissingError,
  );
  const httpResult = await getReleasedWorkspaceHttpResult(actor, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 422);
});

// ------------------------------------------------------------
// 7. non-RELEASED revision -> controlled response, no plan constructed
// ------------------------------------------------------------

test("non-RELEASED revision: controlled 409, no released plan constructed", async () => {
  const db = new FakeDatabase();
  for (const lifecycle of [
    LifecycleState.WORKING,
    LifecycleState.IN_REVIEW,
    LifecycleState.APPROVED,
    LifecycleState.SUPERSEDED,
    LifecycleState.OBSOLETE,
  ]) {
    const id = `rev-${lifecycle}`;
    db.addRevision({ organizationId: "orgA", id, lifecycle });
    const actor = actorIn("orgA");
    await assert.rejects(
      () => getReleasedWorkspacePlanForActor(actor, id, db.db, db.provider),
      RevisionNotReleasedError,
    );
    const httpResult = await getReleasedWorkspaceHttpResult(actor, id, db.db, db.provider);
    assert.equal(httpResult.status, 409, `lifecycle ${lifecycle} must map to 409`);
  }
});

// ------------------------------------------------------------
// 8. zero-entry valid baseline -> valid empty plan
// ------------------------------------------------------------

test("zero-entry valid baseline: returns a valid empty released workspace plan, not an error", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  // No entries at all.
  const actor = actorIn("orgA");

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.documentCount, 0);
  assert.equal(plan.safe, true);
  assert.equal(plan.contract.id, RELEASED_WORKSPACE_CONTRACT_ID);

  const httpResult = await getReleasedWorkspaceHttpResult(actor, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 200);
});

// ------------------------------------------------------------
// 9. cross-tenant revision -> hidden/not found
// ------------------------------------------------------------

test("cross-tenant revision is hidden as 404, never leaked", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db);
  const outsider = actorIn("orgB");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(outsider, "rev-1", db.db, db.provider),
    ItemRevisionNotFoundError,
  );
  const httpResult = await getReleasedWorkspaceHttpResult(outsider, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 404);
  assert.ok(!JSON.stringify(httpResult.body).includes("orgA"));
});

// ------------------------------------------------------------
// 10. VIEWER read access works under existing policy
// ------------------------------------------------------------

test("VIEWER can retrieve released data (read-only, no write-role gate, matching existing read-endpoint policy)", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db);
  const viewer = actorIn("orgA", { role: UserRole.VIEWER });

  const plan = await getReleasedWorkspacePlanForActor(viewer, "rev-1", db.db, db.provider);
  assert.equal(plan.entries.length, 1);

  const httpResult = await getReleasedWorkspaceHttpResult(viewer, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 200);
});

test("unauthenticated retrieval is denied (401), never touches the database", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db);

  const httpResult = await getReleasedWorkspaceHttpResult(null, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 401);
});

// ------------------------------------------------------------
// 11. deterministic ordering
// ------------------------------------------------------------

test("deterministic ordering: entries are CadDocument ID ascending regardless of insertion/database order", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  // Inserted deliberately out of order.
  for (const doc of ["doc-zebra", "doc-apple", "doc-mango"]) {
    db.addDoc({ organizationId: "orgA", id: doc, documentNumber: doc, fileName: `${doc}.ipt`, documentType: "IPT" });
    db.addVersion({ organizationId: "orgA", id: `fv-${doc}`, cadDocumentId: doc, versionNumber: 1, checksum: "c", fileSize: 10, storageKey: `org/orgA/doc/${doc}/v1/x`, originalFileName: `${doc}.ipt` });
    db.addEntry({ organizationId: "orgA", id: `rbe-${doc}`, releaseBaselineId: "rb-1", cadDocumentId: doc, fileVersionId: `fv-${doc}` });
  }
  const actor = actorIn("orgA");

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);
  assert.deepEqual(
    plan.entries.map((e) => e.cadDocumentId),
    ["doc-apple", "doc-mango", "doc-zebra"],
  );
});

// ------------------------------------------------------------
// 15. no baseline mutation during retrieval
// ------------------------------------------------------------

test("retrieval never mutates the baseline/entries/revision (read-only)", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db);
  const actor = actorIn("orgA");

  const baselinesBefore = JSON.stringify(db.baselines);
  const entriesBefore = JSON.stringify(db.entries);
  const revisionsBefore = JSON.stringify(db.revisions);

  await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);

  assert.equal(JSON.stringify(db.baselines), baselinesBefore);
  assert.equal(JSON.stringify(db.entries), entriesBefore);
  assert.equal(JSON.stringify(db.revisions), revisionsBefore);
});

// ------------------------------------------------------------
// 16. byte-level integrity verification (Codex HIGH follow-up)
// ------------------------------------------------------------

test("pinned object with matching stored bytes (correct SHA-256 + size): released plan succeeds", async () => {
  const db = new FakeDatabase();
  seedReleasedRevisionPinningV1(db); // stored bytes default to checksum-v1 / 100
  const actor = actorIn("orgA");

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.version!.fileVersionId, "fv-1-v1");

  const httpResult = await getReleasedWorkspaceHttpResult(actor, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 200);
});

test("stored object exists but its SHA-256 no longer matches the pinned FileVersion: 422 integrity error", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "part.ipt", documentType: "IPT" });
  db.addVersion(
    { organizationId: "orgA", id: "fv-1-v1", cadDocumentId: "doc-1", versionNumber: 1, checksum: "checksum-v1", fileSize: 100, storageKey: "org/orgA/doc/doc-1/v1/x", originalFileName: "part.ipt" },
    true,
    { sha256: "checksum-TAMPERED" }, // object present, different bytes
  );
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleasedBinaryIntegrityError);
      assert.equal(error.reason, "corrupt");
      assert.equal(error.fileVersionId, "fv-1-v1");
      assert.ok(!error.message.includes("checksum-v1"), "must not restate the expected checksum");
      assert.ok(!error.message.includes("checksum-TAMPERED"), "must not restate the actual checksum");
      return true;
    },
  );

  const httpResult = await getReleasedWorkspaceHttpResult(actor, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 422);
});

test("same-size corrupted object (identical byte length, different content): checksum mismatch still fails", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "part.ipt", documentType: "IPT" });
  db.addVersion(
    { organizationId: "orgA", id: "fv-1-v1", cadDocumentId: "doc-1", versionNumber: 1, checksum: "checksum-v1", fileSize: 100, storageKey: "org/orgA/doc/doc-1/v1/x", originalFileName: "part.ipt" },
    true,
    { sha256: "checksum-swapped-same-length", size: 100 }, // size matches, hash does not
  );
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleasedBinaryIntegrityError);
      assert.equal(error.reason, "corrupt");
      return true;
    },
  );
});

test("stored object size differs from the pinned FileVersion.fileSize: integrity error", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "part.ipt", documentType: "IPT" });
  db.addVersion(
    { organizationId: "orgA", id: "fv-1-v1", cadDocumentId: "doc-1", versionNumber: 1, checksum: "checksum-v1", fileSize: 100, storageKey: "org/orgA/doc/doc-1/v1/x", originalFileName: "part.ipt" },
    true,
    { sha256: "checksum-v1", size: 999 }, // hash matches, size does not
  );
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleasedBinaryIntegrityError);
      assert.equal(error.reason, "corrupt");
      return true;
    },
  );
});

test("pinned V1 corrupt while a healthy V2 exists: retrieval FAILS, V2 is never substituted", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addDoc({ organizationId: "orgA", id: "doc-1", documentNumber: "DOC-1", fileName: "assembly.iam", documentType: "IAM" });
  // V1 pinned - stored object is present but its bytes are corrupt.
  db.addVersion(
    { organizationId: "orgA", id: "fv-1-v1", cadDocumentId: "doc-1", versionNumber: 1, checksum: "checksum-v1", fileSize: 100, storageKey: "org/orgA/doc/doc-1/v1/aaa", originalFileName: "assembly.iam" },
    true,
    { sha256: "checksum-v1-CORRUPT", size: 100 },
  );
  // V2 exists and is perfectly healthy - must never be returned.
  db.addVersion({ organizationId: "orgA", id: "fv-1-v2", cadDocumentId: "doc-1", versionNumber: 2, checksum: "checksum-v2", fileSize: 200, storageKey: "org/orgA/doc/doc-1/v2/bbb", originalFileName: "assembly.iam" });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  db.addEntry({ organizationId: "orgA", id: "rbe-1", releaseBaselineId: "rb-1", cadDocumentId: "doc-1", fileVersionId: "fv-1-v1" });
  const actor = actorIn("orgA");

  await assert.rejects(
    () => getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, db.provider),
    (error: unknown) => {
      assert.ok(error instanceof ReleasedBinaryIntegrityError);
      assert.equal(error.reason, "corrupt");
      assert.equal(error.fileVersionId, "fv-1-v1", "the failure is reported against the PINNED version, never V2");
      return true;
    },
  );

  const httpResult = await getReleasedWorkspaceHttpResult(actor, "rev-1", db.db, db.provider);
  assert.equal(httpResult.status, 422);
  assert.ok(!JSON.stringify(httpResult.body).includes("fv-1-v2"), "V2 must never appear anywhere in the response");
});

test("zero-entry baseline stays valid without any storage hashing (no hashObject call)", async () => {
  const db = new FakeDatabase();
  db.addRevision({ organizationId: "orgA", id: "rev-1", lifecycle: LifecycleState.RELEASED });
  db.addBaseline({ organizationId: "orgA", id: "rb-1", itemRevisionId: "rev-1", createdById: "user-orgA" });
  const actor = actorIn("orgA");

  let hashCalls = 0;
  const countingProvider = {
    async hashObject(key: string) {
      hashCalls += 1;
      return db.provider.hashObject(key);
    },
  };

  const plan = await getReleasedWorkspacePlanForActor(actor, "rev-1", db.db, countingProvider);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.safe, true);
  assert.equal(hashCalls, 0, "an empty baseline must not touch storage at all");
});

// ------------------------------------------------------------
// Regression proof: normal Get Latest / working resolution is untouched -
// this module never imports resolveCurrentFileVersion at all.
// ------------------------------------------------------------

test("this module never imports the shared current-version resolver (structural proof, not just behavioral)", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/lib/released-workspace-db.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    !src.includes('from "./file-version-resolution-core.ts"'),
    "released-workspace-db.ts must never import the shared current-version resolver module",
  );
});
