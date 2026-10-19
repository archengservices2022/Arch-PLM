/**
 * Focused tests for the P6C materialization Prisma-shaped wiring
 * (`app/lib/copy-design-materialize-db.ts`). In-memory fake DB with a REAL
 * per-row async mutex behind `$transaction` + `$queryRaw` ("... FOR UPDATE"),
 * mirroring `tests/upload-guard-db.test.ts` / `tests/checkin-db.test.ts`
 * exactly, so the concurrent-materialization race test genuinely exercises
 * blocking + post-unblock re-evaluation. A REAL PostgreSQL race is proven
 * separately in `scripts/itest-p6c-materialize.ts`.
 *
 * Storage is the REAL `LocalFilesystemStorage` against a temp directory,
 * since this module reuses the SAME stage/promote/discard primitives
 * `uploadCadFileVersion` is built from.
 *
 * Run with:  node --experimental-strip-types --test tests/copy-design-materialize-db.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import { LocalFilesystemStorage, sha256Hex } from "../app/lib/storage-core.ts";
import type { CopyDesignMaterializeRequestMeta } from "../app/lib/copy-design-materialize-core.ts";
import {
  CopyDesignAlreadyMaterializedError,
  CopyDesignMaterializeCompensationFailedError,
  CopyDesignMaterializeConcurrencyConflictError,
  CopyDesignMaterializeEligibilityError,
  CopyDesignMaterializeIntegrityError,
  CopyDesignMaterializeInvalidStateError,
  CopyDesignMaterializeMismatchError,
  CopyDesignMaterializeRoleError,
  copyDesignMaterializeHttpResult,
  materializeFirstFileVersionForActor,
  type CopyDesignMaterializeDb,
} from "../app/lib/copy-design-materialize-db.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-copy-design-materialize-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function bytesSource(content: Buffer): Readable {
  return Readable.from([content]);
}

// ------------------------------------------------------------
// In-memory fake database (RowLock mirrors upload-guard-db.test.ts exactly)
// ------------------------------------------------------------

class RowLock {
  #tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.#tail;
    this.#tail = prior.then(() => mine);
    await prior;
    return release;
  }
}

interface DocRow {
  organizationId: string;
  id: string;
  documentType: string;
}
interface LineageRow {
  organizationId: string;
  newCadDocumentId: string;
  sourceCadDocumentId: string;
  copyDesignOperationId: string;
}
interface VersionRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
  originalFileName: string;
  storageKey: string;
  fileSize: bigint;
  checksum: string;
  createdById: string;
}

class FakeDatabase {
  readonly docs: DocRow[] = [];
  readonly lineages: LineageRow[] = [];
  readonly versions: VersionRow[] = [];
  readonly #locks = new Map<string, RowLock>();
  transactionAttempts = 0;

  addDoc(organizationId: string, id: string, documentType = "IPT"): this {
    this.docs.push({ organizationId, id, documentType });
    return this;
  }
  addLineage(row: LineageRow): this {
    this.lineages.push(row);
    return this;
  }
  /** Directly injects an arbitrary FileVersion row, bypassing the normal
   *  creation flow - used to construct MALFORMED states (only v2, v1+v2,
   *  etc.) that the module itself would never produce. */
  addVersionRow(row: VersionRow): this {
    this.versions.push(row);
    return this;
  }

  #lockFor(key: string): RowLock {
    let lock = this.#locks.get(key);
    if (!lock) {
      lock = new RowLock();
      this.#locks.set(key, lock);
    }
    return lock;
  }

  #findLineageJoin(where: { organizationId: string; newCadDocumentId: string; sourceCadDocumentId: string; copyDesignOperationId: string }) {
    const lineage = this.lineages.find(
      (l) =>
        l.organizationId === where.organizationId &&
        l.newCadDocumentId === where.newCadDocumentId &&
        l.sourceCadDocumentId === where.sourceCadDocumentId &&
        l.copyDesignOperationId === where.copyDesignOperationId,
    );
    if (!lineage) return null;
    const doc = this.docs.find((d) => d.id === lineage.newCadDocumentId && d.organizationId === lineage.organizationId);
    if (!doc) return null;
    return { newCadDocument: { id: doc.id, documentType: doc.documentType } };
  }

  #findVersion1(organizationId: string, cadDocumentId: string): VersionRow | null {
    return this.versions.find(
      (v) => v.organizationId === organizationId && v.cadDocumentId === cadDocumentId && v.versionNumber === 1,
    ) ?? null;
  }

  #findAllVersions(organizationId: string, cadDocumentId: string): VersionRow[] {
    return this.versions.filter((v) => v.organizationId === organizationId && v.cadDocumentId === cadDocumentId);
  }

  #createVersion(data: {
    organizationId: string;
    cadDocumentId: string;
    createdById: string;
    versionNumber: number;
    originalFileName: string;
    storageKey: string;
    fileSize: bigint;
    checksum: string;
  }) {
    const row: VersionRow = {
      organizationId: data.organizationId,
      cadDocumentId: data.cadDocumentId,
      id: `fv-${randomBytes(6).toString("hex")}`,
      versionNumber: data.versionNumber,
      originalFileName: data.originalFileName,
      storageKey: data.storageKey,
      fileSize: data.fileSize,
      checksum: data.checksum,
      createdById: data.createdById,
    };
    this.versions.push(row);
    return { id: row.id, versionNumber: row.versionNumber, originalFileName: row.originalFileName, fileSize: row.fileSize, checksum: row.checksum, storageKey: row.storageKey };
  }

  #makeTx(self: FakeDatabase) {
    return {
      $queryRaw: (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const cadDocumentId = values[0] as string;
        const organizationId = values[1] as string;
        const row = self.docs.find((d) => d.id === cadDocumentId && d.organizationId === organizationId);
        if (!row) return [];
        return [{ id: row.id, organizationId: row.organizationId }];
      }) as unknown,
      cadCopyLineage: {
        findFirst: (async (args: { where: { organizationId: string; newCadDocumentId: string; sourceCadDocumentId: string; copyDesignOperationId: string } }) => {
          return self.#findLineageJoin(args.where);
        }) as unknown,
      },
      fileVersion: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string; versionNumber: number } }) => {
          const row = self.#findVersion1(args.where.organizationId, args.where.cadDocumentId);
          return row
            ? { id: row.id, versionNumber: row.versionNumber, originalFileName: row.originalFileName, fileSize: row.fileSize, checksum: row.checksum, storageKey: row.storageKey }
            : null;
        }) as unknown,
        findMany: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          return self.#findAllVersions(args.where.organizationId, args.where.cadDocumentId).map((row) => ({
            id: row.id, versionNumber: row.versionNumber, originalFileName: row.originalFileName,
            fileSize: row.fileSize, checksum: row.checksum, storageKey: row.storageKey,
          }));
        }) as unknown,
        create: (async (args: {
          data: {
            organizationId: string;
            cadDocumentId: string;
            createdById: string;
            versionNumber: number;
            originalFileName: string;
            storageKey: string;
            fileSize: bigint;
            checksum: string;
          };
        }) => self.#createVersion(args.data)) as unknown,
      },
    };
  }

  get db(): CopyDesignMaterializeDb {
    const self = this;
    return {
      cadCopyLineage: {
        findFirst: (async (args: { where: { organizationId: string; newCadDocumentId: string; sourceCadDocumentId: string; copyDesignOperationId: string } }) => {
          return self.#findLineageJoin(args.where);
        }) as unknown,
      } as unknown as CopyDesignMaterializeDb["cadCopyLineage"],
      fileVersion: {
        findFirst: (async (args: { where: { organizationId: string; cadDocumentId: string; versionNumber: number } }) => {
          const row = self.#findVersion1(args.where.organizationId, args.where.cadDocumentId);
          return row
            ? { id: row.id, versionNumber: row.versionNumber, originalFileName: row.originalFileName, fileSize: row.fileSize, checksum: row.checksum, storageKey: row.storageKey }
            : null;
        }) as unknown,
        findMany: (async (args: { where: { organizationId: string; cadDocumentId: string } }) => {
          return self.#findAllVersions(args.where.organizationId, args.where.cadDocumentId).map((row) => ({
            id: row.id, versionNumber: row.versionNumber, originalFileName: row.originalFileName,
            fileSize: row.fileSize, checksum: row.checksum, storageKey: row.storageKey,
          }));
        }) as unknown,
      } as unknown as CopyDesignMaterializeDb["fileVersion"],
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
        self.transactionAttempts += 1;
        const releases: Array<() => void> = [];
        const tx = self.#makeTx(self);
        const lockedQueryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const cadDocumentId = values[0] as string;
          const organizationId = values[1] as string;
          const lockKey = `${organizationId}:${cadDocumentId}`;
          const release = await self.#lockFor(lockKey).acquire();
          releases.push(release);
          return (tx.$queryRaw as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
        }) as unknown;
        try {
          return await fn({ ...tx, $queryRaw: lockedQueryRaw });
        } finally {
          for (const release of releases) release();
        }
      }) as unknown as CopyDesignMaterializeDb["$transaction"],
    };
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

function metaFor(overrides: Partial<CopyDesignMaterializeRequestMeta> = {}, content: Buffer): CopyDesignMaterializeRequestMeta {
  return {
    copyDesignOperationId: "op-1",
    cadDocumentId: "cad-new-1",
    sourceCadDocumentId: "src-1",
    documentType: "IPT",
    originalFileName: "10137-P001.ipt",
    expectedSha256: sha256Hex(content),
    expectedFileSize: content.length,
    ...overrides,
  };
}

function setupReserved(fake: FakeDatabase, org = "orgA") {
  fake.addDoc(org, "src-1", "IPT"); // source document (unrelated row, present for realism)
  fake.addDoc(org, "cad-new-1", "IPT"); // the RESERVED target: zero FileVersions, has lineage
  fake.addLineage({ organizationId: org, newCadDocumentId: "cad-new-1", sourceCadDocumentId: "src-1", copyDesignOperationId: "op-1" });
}

const CONTENT = Buffer.from("hello inventor binary content");

// ------------------------------------------------------------
// 1-2: happy path
// ------------------------------------------------------------

test("reserved copy target with zero versions creates FileVersion 1 with the resulting cadDocumentId", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    const result = await materializeFirstFileVersionForActor(
      actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
    );

    assert.equal(result.versionNumber, 1);
    assert.equal(result.cadDocumentId, "cad-new-1");
    assert.equal(result.copyDesignOperationId, "op-1");
    assert.equal(result.sha256, sha256Hex(CONTENT));
    assert.equal(result.fileSize, CONTENT.length);
    assert.equal(result.idempotentReplay, false);
    assert.equal(fake.versions.length, 1);
  });
});

// ------------------------------------------------------------
// 3-5: no mutation of source / lineage
// ------------------------------------------------------------

test("source CadDocument, source FileVersion state, and lineage are all unchanged", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const lineageBefore = JSON.stringify(fake.lineages);
    const docsBefore = JSON.stringify(fake.docs);
    const provider = new LocalFilesystemStorage(dir);

    await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);

    assert.equal(JSON.stringify(fake.lineages), lineageBefore);
    assert.equal(JSON.stringify(fake.docs), docsBefore);
    // no version was ever created for the SOURCE document
    assert.equal(fake.versions.filter((v) => v.cadDocumentId === "src-1").length, 0);
  });
});

// ------------------------------------------------------------
// 6: normal non-copy CadDocument rejected
// ------------------------------------------------------------

test("a normal CadDocument with no lineage row at all is rejected", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    fake.addDoc("orgA", "cad-normal", "IPT"); // no lineage row
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({ cadDocumentId: "cad-normal" }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeEligibilityError,
    );
    assert.equal(fake.versions.length, 0);
  });
});

// ------------------------------------------------------------
// 7: copy target with existing FileVersion rejected/conflict
// ------------------------------------------------------------

test("a copy target that already has a DIFFERENT FileVersion 1 is rejected as a conflict", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    fake.versions.push({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-existing", versionNumber: 1,
      originalFileName: "existing.ipt", storageKey: "org/orgA/doc/cad-new-1/v1/existing", fileSize: BigInt(999), checksum: "deadbeef",
      createdById: "someone",
    });
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignAlreadyMaterializedError,
    );
    assert.equal(fake.versions.length, 1); // no second row created
  });
});

// ------------------------------------------------------------
// 8: wrong CopyDesignOperationId rejected
// ------------------------------------------------------------

test("a wrong copyDesignOperationId is rejected the same way as a missing lineage", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({ copyDesignOperationId: "op-WRONG" }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeEligibilityError,
    );
  });
});

test("a wrong sourceCadDocumentId is rejected the same way", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({ sourceCadDocumentId: "src-WRONG" }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeEligibilityError,
    );
  });
});

// ------------------------------------------------------------
// 9: wrong-tenant target rejected without leakage
// ------------------------------------------------------------

test("a cross-tenant target is rejected with the SAME generic eligibility error - no leakage", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake, "orgA");
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgB"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => {
        assert.ok(err instanceof CopyDesignMaterializeEligibilityError);
        assert.ok(!err.message.includes("cad-new-1"));
        assert.ok(!err.message.includes("orgA"));
        return true;
      },
    );
  });
});

// ------------------------------------------------------------
// 10: wrong document type rejected
// ------------------------------------------------------------

test("a documentType that does not match the reserved CadDocument's own type is rejected", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake); // reserved target is IPT
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({ documentType: "IAM" }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeEligibilityError,
    );
  });
});

// ------------------------------------------------------------
// 11-12: uploaded bytes vs declared metadata mismatch
// ------------------------------------------------------------

test("uploaded size mismatch (declared fileSize wrong) is rejected before any DB mutation", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({ expectedFileSize: CONTENT.length + 1 }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeMismatchError && err.field === "fileSize",
    );
    assert.equal(fake.versions.length, 0);
  });
});

test("uploaded SHA-256 mismatch (declared hash wrong) is rejected before any DB mutation", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({ expectedSha256: "f".repeat(64) }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeMismatchError && err.field === "sha256",
    );
    assert.equal(fake.versions.length, 0);
  });
});

// ------------------------------------------------------------
// 13-14: idempotency
// ------------------------------------------------------------

test("an exact retry (identical bytes) returns the SAME FileVersion as idempotent success", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    const first = await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);
    const second = await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);

    assert.equal(second.fileVersionId, first.fileVersionId);
    assert.equal(second.idempotentReplay, true);
    assert.equal(fake.versions.length, 1); // never a second row
  });
});

test("a retry with DIFFERENT bytes/hash is rejected as a conflict, never silently replacing version 1", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const differentContent = Buffer.from("a completely different binary");

    await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA"), metaFor({}, differentContent), bytesSource(differentContent), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignAlreadyMaterializedError,
    );
    assert.equal(fake.versions.length, 1);
  });
});

// ------------------------------------------------------------
// 15-16: concurrency - at most one FileVersion 1, never a version 2
// ------------------------------------------------------------

test("two concurrent materialization requests for the same target create AT MOST ONE FileVersion 1", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    const results = await Promise.allSettled([
      materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
    ]);

    // Same content on both -> BOTH may report success (one real create, one
    // idempotent replay of it) - either way, exactly one FileVersion exists.
    assert.equal(fake.versions.length, 1);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof materializeFirstFileVersionForActor>>>[];
    assert.equal(fulfilled.length, 2);
    assert.equal(fulfilled[0].value.fileVersionId, fulfilled[1].value.fileVersionId);
    // never a version 2
    assert.ok(fake.versions.every((v) => v.versionNumber === 1));
  });
});

test("concurrent requests with DIFFERENT content never both succeed - the loser conflicts, never creates version 2", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const otherContent = Buffer.from("a different upload racing the first");

    const results = await Promise.allSettled([
      materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, otherContent), bytesSource(otherContent), 10_000_000, fake.db, provider),
    ]);

    assert.equal(fake.versions.length, 1);
    assert.ok(fake.versions.every((v) => v.versionNumber === 1));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof CopyDesignAlreadyMaterializedError);
  });
});

// ------------------------------------------------------------
// role / auth
// ------------------------------------------------------------

test("VIEWER role cannot materialize", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () =>
        materializeFirstFileVersionForActor(
          actorIn("orgA", UserRole.VIEWER), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider,
        ),
      (err: unknown) => err instanceof CopyDesignMaterializeRoleError,
    );
    assert.equal(fake.versions.length, 0);
  });
});

// ------------------------------------------------------------
// HTTP mapping
// ------------------------------------------------------------

test("http: no actor -> 401, does not touch the database", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    const provider = new LocalFilesystemStorage(dir);
    const res = await copyDesignMaterializeHttpResult(null, metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);
    assert.equal(res.status, 401);
    assert.equal(fake.versions.length, 0);
  });
});

test("http: happy path is 201 with the expected DTO shape; identical retry is 200", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    const first = await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);
    assert.equal(first.status, 201);
    const body = first.body as Record<string, unknown>;
    assert.ok(body.fileVersionId);
    assert.equal(body.versionNumber, 1);
    assert.equal(body.cadDocumentId, "cad-new-1");
    assert.equal(body.copyDesignOperationId, "op-1");

    const second = await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);
    assert.equal(second.status, 200);
  });
});

test("http: role -> 403; eligibility -> 404; already-materialized -> 409; mismatch -> 400", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    assert.equal(
      (await copyDesignMaterializeHttpResult(actorIn("orgA", UserRole.VIEWER), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider)).status,
      403,
    );
    assert.equal(
      (await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({ cadDocumentId: "nope" }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider)).status,
      404,
    );
    assert.equal(
      (await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({ expectedSha256: "f".repeat(64) }, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider)).status,
      400,
    );
    await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);
    const differentContent = Buffer.from("different bytes for conflict test");
    assert.equal(
      (await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({}, differentContent), bytesSource(differentContent), 10_000_000, fake.db, provider)).status,
      409,
    );
  });
});

// ------------------------------------------------------------
// 17-18: storage / DB failure compensation
// ------------------------------------------------------------

/** Delegates every call to a REAL `LocalFilesystemStorage` instance via
 *  bound method references (never prototype/clone tricks, which would break
 *  its true ECMAScript-private `#root` field), with individual methods
 *  overridable per test. */
function wrapProvider(
  real: LocalFilesystemStorage,
  overrides: Partial<import("../app/lib/storage-core.ts").StorageProvider> = {},
): import("../app/lib/storage-core.ts").StorageProvider {
  return {
    put: real.put.bind(real),
    get: real.get.bind(real),
    stageStream: real.stageStream.bind(real),
    promoteStaged: real.promoteStaged.bind(real),
    discardStaged: real.discardStaged.bind(real),
    openReadStream: real.openReadStream.bind(real),
    hashObject: real.hashObject.bind(real),
    delete: real.delete.bind(real),
    exists: real.exists.bind(real),
    ...overrides,
  };
}

test("a storage promotion failure creates no FileVersion row and stages nothing left behind", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    const provider = wrapProvider(real, {
      promoteStaged: async () => {
        throw new Error("simulated storage promotion failure");
      },
    });

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      /simulated storage promotion failure/,
    );
    assert.equal(fake.versions.length, 0);
  });
});

test("a DB failure after successful promotion deletes the orphaned promoted object (compensation)", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    const deletedKeys: string[] = [];
    const provider = wrapProvider(real, {
      delete: async (key: string) => {
        deletedKeys.push(key);
        return real.delete(key);
      },
    });

    // Force the transaction's create step to fail with a genuine,
    // unexpected DB error (not a recognized conflict type).
    const dbWithFailingCreate: CopyDesignMaterializeDb = {
      ...fake.db,
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
        const inner = await (fake.db.$transaction as unknown as (f: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(
          async (tx) => {
            const rigged = {
              ...(tx as Record<string, unknown>),
              fileVersion: {
                ...(tx as { fileVersion: Record<string, unknown> }).fileVersion,
                create: async () => {
                  throw new Error("simulated unexpected DB failure");
                },
              },
            };
            return fn(rigged);
          },
        );
        return inner;
      }) as unknown as CopyDesignMaterializeDb["$transaction"],
    };

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, dbWithFailingCreate, provider),
      /simulated unexpected DB failure/,
    );
    assert.equal(fake.versions.length, 0);
    // The promoted object was orphaned by the failed transaction, then compensated.
    assert.equal(deletedKeys.length, 1);
    assert.equal(await real.exists(deletedKeys[0]), false);
  });
});

/** Rigs `fake.db.$transaction` so `tx.fileVersion.create` always throws
 *  `error` - used to force a genuine, unexpected DB failure deep inside the
 *  authoritative transaction without touching the fake's real create logic. */
function dbWithFailingCreate(fake: FakeDatabase, error: Error): CopyDesignMaterializeDb {
  return {
    ...fake.db,
    $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
      return (fake.db.$transaction as unknown as (f: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(
        async (tx) => {
          const rigged = {
            ...(tx as Record<string, unknown>),
            fileVersion: {
              ...(tx as { fileVersion: Record<string, unknown> }).fileVersion,
              create: async () => {
                throw error;
              },
            },
          };
          return fn(rigged);
        },
      );
    }) as unknown as CopyDesignMaterializeDb["$transaction"],
  };
}

// ------------------------------------------------------------
// Round 2, HIGH 2: idempotent replay must verify the ACTUAL stored object,
// never DB metadata alone.
// ------------------------------------------------------------

test("exact retry with the existing stored object MISSING fails with an integrity error, never reports replay success", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    // A FileVersion 1 row exists with metadata that WOULD match the staged
    // upload, but its storage object was never actually written (missing).
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-missing", versionNumber: 1,
      originalFileName: "new1.ipt", storageKey: "org/orgA/doc/cad-new-1/v1/never-written",
      fileSize: BigInt(CONTENT.length), checksum: sha256Hex(CONTENT), createdById: "someone",
    });

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignMaterializeIntegrityError,
    );
    assert.equal(fake.versions.length, 1); // the existing row is never touched/replaced
  });
});

test("exact retry with the existing stored object CORRUPTED (bytes altered after write) fails with an integrity error", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const storageKey = "org/orgA/doc/cad-new-1/v1/corrupted";
    // The object on disk does NOT match the checksum recorded for it -
    // simulates silent bit-rot / an out-of-band write after the original
    // upload.
    await provider.put(storageKey, Buffer.from("these are NOT the original bytes at all"));
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-corrupt", versionNumber: 1,
      originalFileName: "new1.ipt", storageKey, fileSize: BigInt(CONTENT.length), checksum: sha256Hex(CONTENT), createdById: "someone",
    });

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignMaterializeIntegrityError,
    );
    // the corrupted object is never touched, deleted, or silently accepted
    assert.equal(await provider.exists(storageKey), true);
  });
});

test("existing FileVersion row's OWN recorded metadata disagreeing with its actual stored object's real size fails with an integrity error", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const storageKey = "org/orgA/doc/cad-new-1/v1/size-mismatch";
    // The row's RECORDED metadata matches the fresh upload exactly (so the
    // cheap metadata-vs-staged comparison alone would wrongly say "replay"),
    // but the object's ACTUAL bytes on disk are a genuinely different,
    // shorter blob - an internally-inconsistent DB record that only a real
    // stored-object read can catch.
    await provider.put(storageKey, Buffer.from("short"));
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-size-mismatch", versionNumber: 1,
      originalFileName: "new1.ipt", storageKey, fileSize: BigInt(CONTENT.length), checksum: sha256Hex(CONTENT), createdById: "someone",
    });

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignMaterializeIntegrityError,
    );
  });
});

test("cleanup after a losing concurrent race NEVER deletes or alters the winner's valid storage object", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);

    const results = await Promise.allSettled([
      materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
    ]);
    assert.ok(results.every((r) => r.status === "fulfilled"));

    const winner = fake.versions[0]!;
    const actual = await provider.hashObject(winner.storageKey);
    assert.equal(actual.sha256, sha256Hex(CONTENT));
    assert.equal(actual.size, CONTENT.length);
    assert.equal(fake.versions.length, 1);
  });
});

// ------------------------------------------------------------
// Round 2, MEDIUM 1: require ZERO FileVersions, not "no version 1" -
// malformed FileVersion states must ALWAYS fail closed.
// ------------------------------------------------------------

test("a target with ONLY a version 2 row (no version 1 at all) is an invalid state - never creates or replays", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-v2-only", versionNumber: 2,
      originalFileName: "new1.ipt", storageKey: "org/orgA/doc/cad-new-1/v2/only", fileSize: BigInt(1), checksum: "irrelevant", createdById: "someone",
    });
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignMaterializeInvalidStateError,
    );
    assert.equal(fake.versions.length, 1); // unchanged - no new row created
  });
});

test("a target with version 1 AND version 2 is an invalid state - never creates or replays", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-v1", versionNumber: 1,
      originalFileName: "new1.ipt", storageKey: "org/orgA/doc/cad-new-1/v1/x", fileSize: BigInt(CONTENT.length), checksum: sha256Hex(CONTENT), createdById: "someone",
    });
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-v2", versionNumber: 2,
      originalFileName: "new1.ipt", storageKey: "org/orgA/doc/cad-new-1/v2/x", fileSize: BigInt(1), checksum: "irrelevant", createdById: "someone",
    });
    const provider = new LocalFilesystemStorage(dir);

    // Even though version 1's metadata WOULD otherwise match the upload
    // exactly, the presence of version 2 makes this state invalid - never a
    // replay.
    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignMaterializeInvalidStateError,
    );
    assert.equal(fake.versions.length, 2); // unchanged
  });
});

test("a target with multiple malformed/duplicate version rows is an invalid state", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-dup-a", versionNumber: 1,
      originalFileName: "new1.ipt", storageKey: "org/orgA/doc/cad-new-1/v1/a", fileSize: BigInt(1), checksum: "aaa", createdById: "someone",
    });
    fake.addVersionRow({
      organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-dup-b", versionNumber: 3,
      originalFileName: "new1.ipt", storageKey: "org/orgA/doc/cad-new-1/v3/b", fileSize: BigInt(1), checksum: "bbb", createdById: "someone",
    });
    const provider = new LocalFilesystemStorage(dir);

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider),
      (err: unknown) => err instanceof CopyDesignMaterializeInvalidStateError,
    );
  });
});

// ------------------------------------------------------------
// Round 2, MEDIUM 2: compensation failure must never be silently swallowed.
// ------------------------------------------------------------

test("DB failure + delete SUCCESS -> the original controlled failure propagates, no compensation error", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const rigged = dbWithFailingCreate(fake, new Error("simulated plain DB failure"));

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, rigged, provider),
      (err: unknown) => !(err instanceof CopyDesignMaterializeCompensationFailedError) && /simulated plain DB failure/.test((err as Error).message),
    );
  });
});

test("DB failure + delete FAILURE -> a CopyDesignMaterializeCompensationFailedError is surfaced, never silently swallowed", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    const provider = wrapProvider(real, {
      delete: async () => {
        throw new Error("simulated delete failure");
      },
    });
    const rigged = dbWithFailingCreate(fake, new Error("simulated plain DB failure"));

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, rigged, provider),
      (err: unknown) => {
        assert.ok(err instanceof CopyDesignMaterializeCompensationFailedError);
        assert.ok(err.originalError instanceof Error && /simulated plain DB failure/.test((err.originalError as Error).message));
        assert.ok(err.cleanupError instanceof Error && /simulated delete failure/.test((err.cleanupError as Error).message));
        assert.ok(err.storageKey.length > 0);
        return true;
      },
    );
    assert.equal(fake.versions.length, 0);
  });
});

test("race/replay path + delete FAILURE (redundant object cannot be cleaned up) is ALSO surfaced, not silently logged away", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    let deleteCalls = 0;
    const provider = wrapProvider(real, {
      delete: async (key: string) => {
        deleteCalls += 1;
        throw new Error("simulated delete failure for redundant object");
      },
    });

    // Seed a REAL, healthy, already-materialized FileVersion 1 directly
    // (simulating "another request already won"), then materialize again
    // with IDENTICAL content - this reaches the fast replay path, which
    // never even attempts to delete anything (nothing was promoted), so we
    // instead force the LOCKED path's replay-signal branch by making the
    // fast pre-check miss and only the locked recheck see it.
    const storageKey = "org/orgA/doc/cad-new-1/v1/winner";
    await real.put(storageKey, CONTENT);
    const winnerRow = { organizationId: "orgA", cadDocumentId: "cad-new-1", id: "fv-winner", versionNumber: 1, originalFileName: "new1.ipt", storageKey, fileSize: BigInt(CONTENT.length), checksum: sha256Hex(CONTENT), createdById: "someone" };

    // Rig the OUTER (fast pre-check) fileVersion.findMany to see NOTHING,
    // while the LOCKED transaction's own findMany sees the real winner row -
    // forcing this request down the "promote, then discover a concurrent
    // winner inside the lock" path even though nothing is truly concurrent.
    const riggedDb: CopyDesignMaterializeDb = {
      ...fake.db,
      fileVersion: {
        ...fake.db.fileVersion,
        findMany: (async () => []) as unknown as CopyDesignMaterializeDb["fileVersion"]["findMany"],
      } as unknown as CopyDesignMaterializeDb["fileVersion"],
    };
    fake.addVersionRow(winnerRow);

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, riggedDb, provider),
      (err: unknown) => {
        assert.ok(err instanceof CopyDesignMaterializeCompensationFailedError);
        // No ORIGINAL failure here - the operation itself would have been a
        // successful replay; only the redundant object's cleanup failed.
        assert.equal(err.originalError, null);
        assert.ok(err.cleanupError instanceof Error);
        return true;
      },
    );
    assert.equal(deleteCalls, 1);
    // The WINNER's own object must survive untouched regardless.
    assert.equal(await real.exists(storageKey), true);
    const stillHealthy = await real.hashObject(storageKey);
    assert.equal(stillHealthy.sha256, sha256Hex(CONTENT));
  });
});

test("a successful operation never invokes storage compensation at all", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    let deleteCalls = 0;
    const provider = wrapProvider(real, {
      delete: async (key: string) => {
        deleteCalls += 1;
        return real.delete(key);
      },
    });

    const result = await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, fake.db, provider);

    assert.equal(result.idempotentReplay, false);
    assert.equal(deleteCalls, 0);
  });
});

// ------------------------------------------------------------
// Milestone 3A / D-1: the REAL PostgreSQL stale-snapshot race. Under
// SERIALIZABLE the loser's in-transaction reads can use a snapshot taken
// before the winner committed (so it sees NO FileVersion), and only its
// INSERT hits the winner's now-committed row through the
// (cadDocumentId, versionNumber) unique index - surfacing as Prisma P2002
// rather than a retryable serialization failure. The in-memory fake's
// row lock alone never produces this, so it is simulated explicitly.
// ------------------------------------------------------------

function prismaUniqueViolation(target: unknown): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string; meta: unknown };
  error.code = "P2002";
  error.meta = { modelName: "FileVersion", target };
  return error;
}

/** The loser's transaction reads a stale (empty) FileVersion set, and the
 *  winner's row becomes visible exactly when the loser's INSERT fails -
 *  as a concurrent commit would. */
function dbWithStaleSnapshotRace(fake: FakeDatabase, winner: VersionRow, error: Error): CopyDesignMaterializeDb {
  return {
    ...fake.db,
    $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => {
      return (fake.db.$transaction as unknown as (f: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(
        async (tx) => {
          const rigged = {
            ...(tx as Record<string, unknown>),
            fileVersion: {
              ...(tx as { fileVersion: Record<string, unknown> }).fileVersion,
              findMany: async () => [],
              create: async () => {
                if (!fake.versions.includes(winner)) fake.versions.push(winner);
                throw error;
              },
            },
          };
          return fn(rigged);
        },
      );
    }) as unknown as CopyDesignMaterializeDb["$transaction"],
  };
}

/** Materializes `content` normally (real row + real stored object), then
 *  withdraws the row so the racing request only observes it at its INSERT. */
async function materializeThenWithdrawWinner(fake: FakeDatabase, provider: LocalFilesystemStorage, content: Buffer): Promise<VersionRow> {
  await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, content), bytesSource(content), 10_000_000, fake.db, provider);
  return fake.versions.pop()!;
}

const VERSION_UNIQUE_FIELDS = ["cadDocumentId", "versionNumber"];
const LOSER_CONTENT = Buffer.from("a different upload that lost the race");

test("D-1: stale-snapshot race with DIFFERENT content -> loser gets CopyDesignAlreadyMaterializedError, not a raw P2002", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    const winner = await materializeThenWithdrawWinner(fake, real, CONTENT);
    const deletedKeys: string[] = [];
    const provider = wrapProvider(real, {
      delete: async (key: string) => {
        deletedKeys.push(key);
        return real.delete(key);
      },
    });
    const db = dbWithStaleSnapshotRace(fake, winner, prismaUniqueViolation(VERSION_UNIQUE_FIELDS));

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, LOSER_CONTENT), bytesSource(LOSER_CONTENT), 10_000_000, db, provider),
      (err: unknown) => err instanceof CopyDesignAlreadyMaterializedError,
    );
    // Exactly the winner's FileVersion 1 - no duplicate, no version 2.
    assert.equal(fake.versions.length, 1);
    assert.equal(fake.versions[0].id, winner.id);
    // The loser's own promoted object was compensated; the winner's is untouched.
    assert.equal(deletedKeys.length, 1);
    assert.notEqual(deletedKeys[0], winner.storageKey);
    assert.equal(await real.exists(deletedKeys[0]), false);
    assert.equal((await real.hashObject(winner.storageKey)).sha256, sha256Hex(CONTENT));
  });
});

test("D-1 http: stale-snapshot race with DIFFERENT content maps to 409, never an unhandled 500", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const winner = await materializeThenWithdrawWinner(fake, provider, CONTENT);
    const db = dbWithStaleSnapshotRace(fake, winner, prismaUniqueViolation(VERSION_UNIQUE_FIELDS));

    const res = await copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({}, LOSER_CONTENT), bytesSource(LOSER_CONTENT), 10_000_000, db, provider);
    assert.equal(res.status, 409);
    assert.equal(fake.versions.length, 1);
  });
});

test("D-1: stale-snapshot race with IDENTICAL content -> idempotent replay of the winner, redundant object compensated", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const real = new LocalFilesystemStorage(dir);
    const winner = await materializeThenWithdrawWinner(fake, real, CONTENT);
    const deletedKeys: string[] = [];
    const provider = wrapProvider(real, {
      delete: async (key: string) => {
        deletedKeys.push(key);
        return real.delete(key);
      },
    });
    const db = dbWithStaleSnapshotRace(fake, winner, prismaUniqueViolation(VERSION_UNIQUE_FIELDS));

    const result = await materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, db, provider);
    assert.equal(result.idempotentReplay, true);
    assert.equal(result.fileVersionId, winner.id);
    assert.equal(fake.versions.length, 1);
    assert.equal(deletedKeys.length, 1);
    assert.notEqual(deletedKeys[0], winner.storageKey);
    assert.equal(await real.exists(winner.storageKey), true);
  });
});

test("D-1: a STRING-shaped meta.target with the EXACT FileVersion version index name is recognized the same way", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const winner = await materializeThenWithdrawWinner(fake, provider, CONTENT);
    const db = dbWithStaleSnapshotRace(fake, winner, prismaUniqueViolation("FileVersion_cadDocumentId_versionNumber_key"));

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, LOSER_CONTENT), bytesSource(LOSER_CONTENT), 10_000_000, db, provider),
      (err: unknown) => err instanceof CopyDesignAlreadyMaterializedError,
    );
  });
});

test("D-1: a P2002 on any OTHER constraint is rethrown unchanged - never converted into a 409", async () => {
  const unrelatedTargets: unknown[] = [
    ["organizationId", "id"], // a different FileVersion unique constraint
    ["cadDocumentId", "versionNumber", "organizationId"], // superset - not an exact match
    ["cadDocumentId"], // subset - not an exact match
    "FileVersion_organizationId_id_key", // different index name
    undefined, // unreadable target
  ];
  for (const target of unrelatedTargets) {
    await withTmpDir(async (dir) => {
      const fake = new FakeDatabase();
      setupReserved(fake);
      const provider = new LocalFilesystemStorage(dir);
      const error = prismaUniqueViolation(target);

      await assert.rejects(
        () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, dbWithFailingCreate(fake, error), provider),
        (err: unknown) => err === error,
        `target ${JSON.stringify(target)} must be rethrown as-is`,
      );
      // The HTTP mapping must not swallow it into a 4xx either.
      await assert.rejects(
        () => copyDesignMaterializeHttpResult(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, dbWithFailingCreate(fake, error), provider),
        (err: unknown) => err === error,
      );
      assert.equal(fake.versions.length, 0);
    });
  }
});

test("D-1: a matching P2002 with NO committed version visible on re-read is rethrown unchanged, never guessed into a 409", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeDatabase();
    setupReserved(fake);
    const provider = new LocalFilesystemStorage(dir);
    const error = prismaUniqueViolation(VERSION_UNIQUE_FIELDS);

    await assert.rejects(
      () => materializeFirstFileVersionForActor(actorIn("orgA"), metaFor({}, CONTENT), bytesSource(CONTENT), 10_000_000, dbWithFailingCreate(fake, error), provider),
      (err: unknown) => err === error,
    );
    assert.equal(fake.versions.length, 0);
  });
});
