/**
 * Focused tests for the PDM Managed Workspace Plan Prisma-shaped wiring
 * (`app/lib/workspace-plan-db.ts`, P3B-2A). Like `get-latest-db.ts`, this
 * module deliberately does NOT import "server-only" (only type-only `Actor`
 * imports, erased at compile time), so it can be exercised directly by the
 * Node test runner with an in-memory fake database and a fake actor.
 *
 * These tests confirm the workspace plan is built strictly by composing the
 * existing, already-tenant-scoped Get Latest pipeline - no new queries, no
 * client-supplied organization id ever reaches a lookup, and unauthorized /
 * cross-tenant access is denied exactly like Get Latest.
 *
 * Run with:  node --experimental-strip-types --test tests/workspace-plan-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import type { StorageProvider } from "../app/lib/storage-core.ts";
import type { GetLatestDb } from "../app/lib/get-latest-db.ts";
import {
  getWorkspacePlanForActor,
  getWorkspacePlanHttpResult,
  RootCadDocumentNotFoundError,
} from "../app/lib/workspace-plan-db.ts";

// ------------------------------------------------------------
// In-memory fake Prisma + storage provider (same shape as
// tests/get-latest-db.test.ts, kept local so this file has no test-only
// cross-file dependency)
// ------------------------------------------------------------

interface DocRow {
  organizationId: string;
  id: string;
  documentNumber: string;
  fileName: string;
  documentType: string;
}
interface EdgeRow {
  organizationId: string;
  parentDocumentId: string;
  childDocumentId: string;
  dependencyType: string;
}
interface VersionRow {
  organizationId: string;
  cadDocumentId: string;
  id: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: bigint | null;
  originalFileName: string;
  storageKey: string;
}

class FakeDatabase {
  docs: DocRow[] = [];
  edges: EdgeRow[] = [];
  versions: VersionRow[] = [];
  readonly calls = {
    cadDocument: [] as Array<{ organizationId: string; ids: string[] }>,
    cadDependency: [] as Array<{ organizationId: string; parentIds: string[] }>,
    fileVersion: [] as Array<{ organizationId: string; cadDocumentId: string }>,
  };

  addDoc(row: DocRow): this {
    this.docs.push(row);
    return this;
  }
  addEdge(row: EdgeRow): this {
    this.edges.push(row);
    return this;
  }
  addVersion(row: VersionRow): this {
    this.versions.push(row);
    return this;
  }

  get db(): GetLatestDb {
    const self = this;
    return {
      cadDocument: {
        findMany: (async (args: {
          where: { organizationId: string; id: { in: string[] } };
        }) => {
          self.calls.cadDocument.push({
            organizationId: args.where.organizationId,
            ids: args.where.id.in,
          });
          const wanted = new Set(args.where.id.in);
          return self.docs.filter(
            (d) =>
              d.organizationId === args.where.organizationId && wanted.has(d.id),
          );
        }) as unknown as GetLatestDb["cadDocument"]["findMany"],
      },
      cadDependency: {
        findMany: (async (args: {
          where: { organizationId: string; parentDocumentId: { in: string[] } };
        }) => {
          self.calls.cadDependency.push({
            organizationId: args.where.organizationId,
            parentIds: args.where.parentDocumentId.in,
          });
          const wanted = new Set(args.where.parentDocumentId.in);
          return self.edges.filter(
            (e) =>
              e.organizationId === args.where.organizationId &&
              wanted.has(e.parentDocumentId),
          );
        }) as unknown as GetLatestDb["cadDependency"]["findMany"],
      },
      fileVersion: {
        findMany: (async (args: {
          where: { organizationId: string; cadDocumentId: string };
        }) => {
          self.calls.fileVersion.push({
            organizationId: args.where.organizationId,
            cadDocumentId: args.where.cadDocumentId,
          });
          return self.versions
            .filter(
              (v) =>
                v.organizationId === args.where.organizationId &&
                v.cadDocumentId === args.where.cadDocumentId,
            )
            .sort((a, b) => b.versionNumber - a.versionNumber);
        }) as unknown as GetLatestDb["fileVersion"]["findMany"],
      },
    } as unknown as GetLatestDb;
  }

  assertAllCallsScopedTo(organizationId: string): void {
    for (const c of this.calls.cadDocument) assert.equal(c.organizationId, organizationId);
    for (const c of this.calls.cadDependency) assert.equal(c.organizationId, organizationId);
    for (const c of this.calls.fileVersion) assert.equal(c.organizationId, organizationId);
    assert.ok(this.calls.cadDocument.length > 0, "expected at least one query to have run");
  }
}

class FakeProvider implements Pick<StorageProvider, "exists"> {
  readonly objects = new Set<string>();
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

function actorIn(organizationId: string): Actor {
  return {
    userId: `user-${organizationId}`,
    organizationId,
    role: UserRole.ENGINEER,
    name: "Test User",
    email: `user@${organizationId}.example`,
  };
}

function seedDocumentWithVersion(
  db: FakeDatabase,
  provider: FakeProvider,
  organizationId: string,
  id: string,
  opts: { documentNumber?: string; fileName?: string; cadType?: string } = {},
): void {
  db.addDoc({
    organizationId,
    id,
    documentNumber: opts.documentNumber ?? id.toUpperCase(),
    fileName: opts.fileName ?? `${id}.ipt`,
    documentType: opts.cadType ?? "IPT",
  });
  const storageKey = `org/${organizationId}/doc/${id}/v1/aaaa1111aaaa1111`;
  db.addVersion({
    organizationId,
    cadDocumentId: id,
    id: `fv-${id}-1`,
    versionNumber: 1,
    checksum: `c-${id}-1`,
    fileSize: 1234n,
    originalFileName: `${id}.ipt`,
    storageKey,
  });
  provider.objects.add(storageKey);
}

// ------------------------------------------------------------
// Unauthorized / malformed input
// ------------------------------------------------------------

test("getWorkspacePlanHttpResult: no actor -> 401, never touches the database", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  const result = await getWorkspacePlanHttpResult(
    null,
    "anything",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(result.status, 401);
  assert.equal(db.calls.cadDocument.length, 0);
});

test("getWorkspacePlanHttpResult: empty/oversized id -> 400", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  const actor = actorIn("orgA");

  const empty = await getWorkspacePlanHttpResult(actor, "", db.db, provider as unknown as StorageProvider);
  assert.equal(empty.status, 400);

  const huge = await getWorkspacePlanHttpResult(
    actor,
    "x".repeat(500),
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(huge.status, 400);
});

// ------------------------------------------------------------
// Tenant isolation
// ------------------------------------------------------------

test("a root belonging to another organization is unreachable (404), not leaked", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1");
  seedDocumentWithVersion(db, provider, "orgB", "b1", { documentNumber: "SECRET-ORGB" });

  const actorA = actorIn("orgA");
  const result = await getWorkspacePlanHttpResult(
    actorA,
    "b1",
    db.db,
    provider as unknown as StorageProvider,
  );

  assert.equal(result.status, 404);
  assert.ok(!JSON.stringify(result.body).includes("SECRET-ORGB"));

  await assert.rejects(
    () => getWorkspacePlanForActor(actorA, "b1", db.db, provider as unknown as StorageProvider),
    RootCadDocumentNotFoundError,
  );
});

test("every database query for a multi-document plan is scoped to the actor's organization", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1", { cadType: "IAM" });
  seedDocumentWithVersion(db, provider, "orgA", "a2");
  db.addEdge({
    organizationId: "orgA",
    parentDocumentId: "a1",
    childDocumentId: "a2",
    dependencyType: "COMPONENT",
  });
  // Noise belonging to a different tenant - must never be visited or returned.
  seedDocumentWithVersion(db, provider, "orgB", "a1");
  db.addEdge({
    organizationId: "orgB",
    parentDocumentId: "a1",
    childDocumentId: "z-orgB-only",
    dependencyType: "COMPONENT",
  });

  const actorA = actorIn("orgA");
  const plan = await getWorkspacePlanForActor(actorA, "a1", db.db, provider as unknown as StorageProvider);

  assert.equal(plan.documentCount, 2);
  assert.equal(plan.safe, true);
  assert.ok(!plan.entries.some((e) => e.cadDocumentId === "z-orgB-only"));
  db.assertAllCallsScopedTo("orgA");
});

// ------------------------------------------------------------
// Success path: contract shape + content path reuse
// ------------------------------------------------------------

test("a successful plan carries the contract id/version and reuses the download endpoint", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1");

  const result = await getWorkspacePlanHttpResult(
    actorIn("orgA"),
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(result.status, 200);
  const body = result.body as {
    contract: { id: string; version: string };
    safe: boolean;
    entries: Array<{
      cadDocumentId: string;
      canMaterialize: boolean;
      version: { contentPath: string; fileVersionId: string } | null;
    }>;
  };
  assert.equal(body.contract.id, "arch-plm.cad-workspace-plan");
  assert.match(body.contract.version, /^\d+\.\d+\.\d+$/);
  assert.equal(body.safe, true);
  const entry = body.entries[0];
  assert.equal(entry.canMaterialize, true);
  assert.equal(
    entry.version!.contentPath,
    `/api/file-versions/${entry.version!.fileVersionId}/content`,
  );
});

// ------------------------------------------------------------
// Missing binary -> unsafe plan, surfaced end-to-end through real storage check
// ------------------------------------------------------------

test("a missing stored binary makes the real end-to-end plan unsafe", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  db.addDoc({
    organizationId: "orgA",
    id: "a1",
    documentNumber: "A1",
    fileName: "a1.ipt",
    documentType: "IPT",
  });
  db.addVersion({
    organizationId: "orgA",
    cadDocumentId: "a1",
    id: "fv-a1-1",
    versionNumber: 1,
    checksum: "c-a1-1",
    fileSize: 10n,
    originalFileName: "a1.ipt",
    storageKey: "org/orgA/doc/a1/v1/missing",
  });
  // Deliberately do NOT add the storage key to provider.objects.

  const plan = await getWorkspacePlanForActor(
    actorIn("orgA"),
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );

  assert.equal(plan.safe, false);
  const entry = plan.entries[0];
  assert.equal(entry.canMaterialize, false);
  assert.deepEqual(entry.blockedReasons, ["missing-binary"]);
  assert.equal(entry.version, null);
});

// ------------------------------------------------------------
// Bounded traversal -> 422
// ------------------------------------------------------------

test("a dependency graph past the node cap maps to 422", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1", { cadType: "IAM" });
  for (let i = 0; i < 5001; i += 1) {
    db.addEdge({
      organizationId: "orgA",
      parentDocumentId: "a1",
      childDocumentId: `c${i}`,
      dependencyType: "COMPONENT",
    });
  }

  const result = await getWorkspacePlanHttpResult(
    actorIn("orgA"),
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(result.status, 422);
});
