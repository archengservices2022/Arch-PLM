/**
 * Focused tests for the PDM "Get Latest" Prisma-shaped wiring
 * (`app/lib/get-latest-db.ts`). This module deliberately does NOT import
 * "server-only" (only type-only `Actor` / `PrismaClient` imports, erased at
 * compile time), so it can be exercised directly by the Node test runner with
 * an in-memory fake database and a fake actor - unlike `app/lib/get-latest.ts`
 * (the real `server-only`-guarded entry point), which cannot be imported
 * outside a Next.js server bundle.
 *
 * These tests are the tenant-isolation / unauthorized-access coverage for
 * Get Latest: every fake-db call is recorded and asserted to be scoped to the
 * calling actor's organization, and a root or edge belonging to another
 * organization is proven unreachable and non-leaking.
 *
 * Run with:  node --experimental-strip-types --test tests/get-latest-db.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UserRole } from "../app/generated/prisma/enums.ts";
import type { Actor } from "../app/lib/authz.ts";
import type { StorageProvider } from "../app/lib/storage-core.ts";
import {
  getLatestManifestForActor,
  getLatestManifestHttpResult,
  RootCadDocumentNotFoundError,
  type GetLatestDb,
} from "../app/lib/get-latest-db.ts";

// ------------------------------------------------------------
// In-memory fake Prisma + storage provider
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
          where: {
            organizationId: string;
            parentDocumentId: { in: string[] };
          };
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

  /** Every recorded call must have been scoped to `organizationId`. */
  assertAllCallsScopedTo(organizationId: string): void {
    for (const c of this.calls.cadDocument) {
      assert.equal(c.organizationId, organizationId);
    }
    for (const c of this.calls.cadDependency) {
      assert.equal(c.organizationId, organizationId);
    }
    for (const c of this.calls.fileVersion) {
      assert.equal(c.organizationId, organizationId);
    }
    assert.ok(
      this.calls.cadDocument.length > 0,
      "expected at least one cadDocument query to have run",
    );
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

test("getLatestManifestHttpResult: no actor -> 401, never touches the database", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  const result = await getLatestManifestHttpResult(
    null,
    "anything",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(result.status, 401);
  assert.equal(db.calls.cadDocument.length, 0);
});

test("getLatestManifestHttpResult: empty/oversized id -> 400", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  const actor = actorIn("orgA");

  const empty = await getLatestManifestHttpResult(
    actor,
    "",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(empty.status, 400);

  const huge = await getLatestManifestHttpResult(
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
  seedDocumentWithVersion(db, provider, "orgB", "b1", {
    documentNumber: "SECRET-ORGB",
  });

  const actorA = actorIn("orgA");
  const result = await getLatestManifestHttpResult(
    actorA,
    "b1",
    db.db,
    provider as unknown as StorageProvider,
  );

  assert.equal(result.status, 404);
  assert.ok(!JSON.stringify(result.body).includes("SECRET-ORGB"));

  await assert.rejects(
    () =>
      getLatestManifestForActor(
        actorA,
        "b1",
        db.db,
        provider as unknown as StorageProvider,
      ),
    RootCadDocumentNotFoundError,
  );
});

test("a dependency edge reaching into another organization is dangling, not traversed, and does not leak data", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1", { cadType: "IAM" });
  seedDocumentWithVersion(db, provider, "orgB", "b-secret", {
    documentNumber: "SECRET-ORGB",
    fileName: "TopSecret.ipt",
  });
  // The edge row itself is tenant-scoped to orgA (as the schema requires),
  // but its target id belongs to orgB - simulating a malformed / stale edge.
  db.addEdge({
    organizationId: "orgA",
    parentDocumentId: "a1",
    childDocumentId: "b-secret",
    dependencyType: "COMPONENT",
  });

  const actorA = actorIn("orgA");
  const manifest = await getLatestManifestForActor(
    actorA,
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );

  assert.equal(manifest.documentCount, 1, "the foreign document is not included");
  assert.ok(!manifest.entries.some((e) => e.cadDocumentId === "b-secret"));
  const dump = JSON.stringify(manifest);
  assert.ok(!dump.includes("SECRET-ORGB"));
  assert.ok(!dump.includes("TopSecret"));
  assert.ok(manifest.problems.some((p) => p.kind === "dangling-dependency"));
  assert.equal(manifest.complete, false);

  db.assertAllCallsScopedTo("orgA");
});

test("every database query for a multi-document graph is scoped to the actor's organization", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1", { cadType: "IAM" });
  seedDocumentWithVersion(db, provider, "orgA", "a2");
  seedDocumentWithVersion(db, provider, "orgA", "a3");
  db.addEdge({
    organizationId: "orgA",
    parentDocumentId: "a1",
    childDocumentId: "a2",
    dependencyType: "COMPONENT",
  });
  db.addEdge({
    organizationId: "orgA",
    parentDocumentId: "a2",
    childDocumentId: "a3",
    dependencyType: "COMPONENT",
  });
  // Noise belonging to a different tenant - must never be visited or returned.
  seedDocumentWithVersion(db, provider, "orgB", "a1"); // same id, different org
  db.addEdge({
    organizationId: "orgB",
    parentDocumentId: "a1",
    childDocumentId: "z-orgB-only",
    dependencyType: "COMPONENT",
  });

  const actorA = actorIn("orgA");
  const manifest = await getLatestManifestForActor(
    actorA,
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );

  assert.equal(manifest.documentCount, 3);
  assert.equal(manifest.complete, true);
  assert.ok(!manifest.entries.some((e) => e.cadDocumentId === "z-orgB-only"));
  db.assertAllCallsScopedTo("orgA");
});

// ------------------------------------------------------------
// Success path + reuse of the existing download endpoint
// ------------------------------------------------------------

test("a resolved entry's contentPath reuses the existing authenticated download endpoint", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1");

  const result = await getLatestManifestHttpResult(
    actorIn("orgA"),
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(result.status, 200);
  const body = result.body as { entries: Array<{ version: { contentPath: string; fileVersionId: string } | null }> };
  const entry = body.entries[0];
  assert.equal(entry.version!.contentPath, `/api/file-versions/${entry.version!.fileVersionId}/content`);
});

// ------------------------------------------------------------
// Bounded traversal -> 422, mapped from CadGraphTooLargeError
// ------------------------------------------------------------

test("a dependency graph past the node cap maps to 422, not a silent partial package", async () => {
  const db = new FakeDatabase();
  const provider = new FakeProvider();
  seedDocumentWithVersion(db, provider, "orgA", "a1", { cadType: "IAM" });
  // One document with more direct children than the (default 5000) node cap.
  // Edge-only: no need to seed 5001 child documents - the cap trips before
  // any of them would be loaded.
  for (let i = 0; i < 5001; i += 1) {
    db.addEdge({
      organizationId: "orgA",
      parentDocumentId: "a1",
      childDocumentId: `c${i}`,
      dependencyType: "COMPONENT",
    });
  }

  const result = await getLatestManifestHttpResult(
    actorIn("orgA"),
    "a1",
    db.db,
    provider as unknown as StorageProvider,
  );
  assert.equal(result.status, 422);
});
