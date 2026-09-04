/**
 * Focused tests for the PDM "Get Latest" manifest core (provider-agnostic).
 *
 * Run with:  node --experimental-strip-types --test tests/get-latest-core.test.ts
 * (also picked up by `npm test`).
 *
 * Excluded from the Next.js build / tsconfig / eslint on purpose - executed by
 * the Node test runner, not bundled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeWorkspacePath,
  buildGetLatestManifest,
  CadGraphTooLargeError,
  RootCadDocumentNotFoundError,
  UnsafeWorkspacePathError,
  workspaceRelativePath,
  type GetLatestDeps,
  type ManifestDependencyEdge,
  type ManifestDocumentRow,
  type ManifestVersionRow,
} from "../app/lib/get-latest-core.ts";

const FIXED_NOW = () => new Date("2026-09-04T12:00:00.000Z");

// ------------------------------------------------------------
// Test graph builder + in-memory deps
// ------------------------------------------------------------

class Graph {
  readonly docs = new Map<string, ManifestDocumentRow>();
  readonly tenant = new Set<string>();
  readonly edges: ManifestDependencyEdge[] = [];
  readonly versions = new Map<string, ManifestVersionRow[]>();
  readonly objects = new Set<string>();

  doc(
    id: string,
    opts: { documentNumber?: string; fileName?: string; cadType?: string } = {},
  ): this {
    this.docs.set(id, {
      id,
      documentNumber: opts.documentNumber ?? id.toUpperCase(),
      fileName: opts.fileName ?? `${id}.ipt`,
      cadType: opts.cadType ?? "IPT",
    });
    this.tenant.add(id);
    return this;
  }

  /** Register a document id that exists but NOT in this tenant. */
  foreignDoc(id: string): this {
    this.docs.set(id, {
      id,
      documentNumber: `FOREIGN-${id}`,
      fileName: `${id}.ipt`,
      cadType: "IPT",
    });
    // deliberately not added to this.tenant
    return this;
  }

  edge(parent: string, child: string, type = "COMPONENT"): this {
    this.edges.push({
      parentDocumentId: parent,
      childDocumentId: child,
      dependencyType: type,
    });
    return this;
  }

  version(
    docId: string,
    versionNumber: number,
    opts: {
      present?: boolean;
      metadataComplete?: boolean;
      checksum?: string;
      fileSize?: number;
    } = {},
  ): this {
    const present = opts.present ?? true;
    const complete = opts.metadataComplete ?? true;
    const storageKey = `org/o/doc/${docId}/v${versionNumber}/${docId}${versionNumber}`;
    const row: ManifestVersionRow = {
      id: `fv-${docId}-${versionNumber}`,
      versionNumber,
      checksum: complete ? (opts.checksum ?? `c-${docId}-${versionNumber}`) : null,
      fileSize: complete ? (opts.fileSize ?? 1000 + versionNumber) : null,
      originalFileName: `${docId}.ipt`,
      storageKey,
    };
    const list = this.versions.get(docId) ?? [];
    list.push(row);
    this.versions.set(docId, list);
    if (present) this.objects.add(storageKey);
    return this;
  }

  deps(overrides: Partial<GetLatestDeps> = {}): GetLatestDeps {
    const self = this;
    return {
      now: FIXED_NOW,
      async loadDocuments(ids) {
        return ids
          .filter((id) => self.tenant.has(id) && self.docs.has(id))
          .map((id) => ({ ...(self.docs.get(id) as ManifestDocumentRow) }));
      },
      async loadChildEdges(parentIds) {
        const wanted = new Set(parentIds);
        return self.edges
          .filter((e) => wanted.has(e.parentDocumentId))
          .map((e) => ({ ...e }));
      },
      async loadVersionsNewestFirst(id) {
        return [...(self.versions.get(id) ?? [])]
          .sort((a, b) => b.versionNumber - a.versionNumber)
          .map((r) => ({ ...r }));
      },
      async objectExists(key) {
        return self.objects.has(key);
      },
      ...overrides,
    };
  }
}

function entryById(manifest: Awaited<ReturnType<typeof buildGetLatestManifest>>) {
  return new Map(manifest.entries.map((e) => [e.cadDocumentId, e]));
}

// ------------------------------------------------------------
// workspace path safety
// ------------------------------------------------------------

test("workspaceRelativePath strips traversal, control chars and disallowed chars", () => {
  assert.equal(workspaceRelativePath("../../../etc/passwd", "DOC-1"), "passwd");
  assert.equal(workspaceRelativePath("C:\\a\\b\\Part 1.ipt", "DOC-1"), "Part_1.ipt");
  assert.equal(
    workspaceRelativePath(`a${String.fromCharCode(0)}b.iam`, "DOC-1"),
    "ab.iam",
  );
  assert.equal(workspaceRelativePath("...hidden", "DOC-1"), "hidden");
  assert.equal(workspaceRelativePath("", "DOC-1"), "DOC-1");
  assert.equal(workspaceRelativePath("///", "10073-MFD/AS210"), "AS210");
  assert.equal(workspaceRelativePath("", ""), "document");
  // Whatever comes out is always a safe relative path.
  for (const name of ["../x", "..\\y", "/abs", "~/h", "a/b/c", "  ", "***"]) {
    assert.doesNotThrow(() =>
      assertSafeWorkspacePath(workspaceRelativePath(name, "FALLBK")),
    );
  }
});

test("assertSafeWorkspacePath rejects unsafe paths", () => {
  for (const bad of ["", "..", "../x", "a/../b", "/x", "~/x", "C:/x", "a\\b", "a//b", "a/./b"]) {
    assert.throws(
      () => assertSafeWorkspacePath(bad),
      UnsafeWorkspacePathError,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
  assert.doesNotThrow(() => assertSafeWorkspacePath("Part_1.ipt"));
});

// ------------------------------------------------------------
// traversal: nested assemblies + shared dependency dedup
// ------------------------------------------------------------

test("nested assembly with a shared sub-component is fully collected and deduplicated", async () => {
  const g = new Graph()
    .doc("a", { cadType: "IAM", fileName: "TopAsm.iam" })
    .doc("b", { cadType: "IAM", fileName: "SubAsm.iam" })
    .doc("c", { cadType: "IPT", fileName: "Plate.ipt" })
    .doc("d", { cadType: "IPT", fileName: "Fastener.ipt" })
    .edge("a", "b")
    .edge("a", "c")
    .edge("b", "d")
    .edge("c", "d"); // d reached through two paths
  for (const id of ["a", "b", "c", "d"]) g.version(id, 1);

  const manifest = await buildGetLatestManifest("a", g.deps());

  assert.equal(manifest.complete, true);
  assert.equal(manifest.documentCount, 4);
  assert.equal(manifest.traversal.visitedCount, 4);
  assert.equal(manifest.entries.filter((e) => e.cadDocumentId === "d").length, 1);

  assert.equal(manifest.entries[0].cadDocumentId, "a");
  assert.equal(manifest.entries[0].isRoot, true);

  const byId = entryById(manifest);
  assert.deepEqual(
    byId.get("a")!.dependsOn.map((d) => d.cadDocumentId),
    ["b", "c"],
  );
  assert.deepEqual(byId.get("b")!.dependsOn.map((d) => d.cadDocumentId), ["d"]);
  assert.deepEqual(byId.get("c")!.dependsOn.map((d) => d.cadDocumentId), ["d"]);
  assert.deepEqual(byId.get("d")!.dependsOn, []);

  // every entry carries the required manifest fields
  for (const e of manifest.entries) {
    assert.ok(e.version, `entry ${e.cadDocumentId} has a version`);
    assert.equal(e.version!.contentPath, `/api/file-versions/${e.version!.fileVersionId}/content`);
    assert.equal(typeof e.version!.checksum, "string");
    assert.equal(typeof e.version!.fileSize, "number");
    assert.equal(typeof e.documentNumber, "string");
    assert.equal(typeof e.cadType, "string");
    assert.doesNotThrow(() => assertSafeWorkspacePath(e.workspacePath));
  }
});

test("manifest output is deterministic regardless of edge / version row order", async () => {
  const build = (shuffle: boolean) => {
    const g = new Graph()
      .doc("root", { fileName: "Root.iam", cadType: "IAM" })
      .doc("x", { fileName: "X.ipt" })
      .doc("y", { fileName: "Y.ipt" })
      .doc("z", { fileName: "Z.ipt" });
    const edges: Array<[string, string]> = [
      ["root", "x"],
      ["root", "y"],
      ["x", "z"],
      ["y", "z"],
    ];
    for (const [p, c] of shuffle ? [...edges].reverse() : edges) g.edge(p, c);
    for (const id of ["root", "x", "y", "z"]) {
      if (shuffle) {
        g.version(id, 2).version(id, 1);
      } else {
        g.version(id, 1).version(id, 2);
      }
    }
    return g.deps();
  };

  const a = await buildGetLatestManifest("root", build(false));
  const b = await buildGetLatestManifest("root", build(true));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ------------------------------------------------------------
// latest binary-backed version selection
// ------------------------------------------------------------

test("resolves the newest version that is binary-backed", async () => {
  const g = new Graph().doc("a");
  // V3 exists but has no checksum/size (not binary-backed) -> skip to V2.
  g.version("a", 1).version("a", 2).version("a", 3, { metadataComplete: false });

  const manifest = await buildGetLatestManifest("a", g.deps());
  const entry = manifest.entries[0];
  assert.equal(entry.version!.versionNumber, 2);
  assert.equal(entry.version!.fileVersionId, "fv-a-2");
  assert.equal(entry.version!.checksum, "c-a-2");
  assert.equal(manifest.complete, true);
});

test("resolves the highest version when every version is binary-backed", async () => {
  const g = new Graph().doc("a");
  g.version("a", 1).version("a", 2).version("a", 3);
  const manifest = await buildGetLatestManifest("a", g.deps());
  assert.equal(manifest.entries[0].version!.versionNumber, 3);
});

// ------------------------------------------------------------
// missing binary / missing version -> incomplete, never omitted
// ------------------------------------------------------------

test("a document whose latest version has no stored binary is reported, not dropped", async () => {
  const g = new Graph()
    .doc("a", { cadType: "IAM" })
    .doc("b")
    .edge("a", "b");
  g.version("a", 1);
  g.version("b", 1, { present: false }); // metadata row exists, bytes gone

  const manifest = await buildGetLatestManifest("a", g.deps());

  assert.equal(manifest.complete, false);
  assert.equal(manifest.documentCount, 2, "b is still in the manifest");
  const b = entryById(manifest).get("b")!;
  assert.equal(b.version, null);
  assert.deepEqual(b.problems, ["missing-binary"]);
  assert.equal(
    manifest.problems.filter(
      (p) => p.kind === "missing-binary" && p.cadDocumentId === "b",
    ).length,
    1,
  );
});

test("a document with no binary-backed version at all is reported as missing-version", async () => {
  const g = new Graph().doc("a").doc("b").edge("a", "b");
  g.version("a", 1);
  // b: only a metadata-incomplete row
  g.version("b", 1, { metadataComplete: false });

  const manifest = await buildGetLatestManifest("a", g.deps());
  assert.equal(manifest.complete, false);
  const b = entryById(manifest).get("b")!;
  assert.equal(b.version, null);
  assert.deepEqual(b.problems, ["missing-version"]);

  // and a document with zero versions
  const g2 = new Graph().doc("a").doc("c").edge("a", "c");
  g2.version("a", 1);
  const m2 = await buildGetLatestManifest("a", g2.deps());
  assert.equal(entryById(m2).get("c")!.problems[0], "missing-version");
});

// ------------------------------------------------------------
// cycles / malformed graph
// ------------------------------------------------------------

test("a pre-existing cycle is traversed safely and terminates", async () => {
  const g = new Graph().doc("a").doc("b").doc("c");
  g.edge("a", "b").edge("b", "c").edge("c", "a"); // cycle
  for (const id of ["a", "b", "c"]) g.version(id, 1);

  const manifest = await buildGetLatestManifest("a", g.deps());
  assert.equal(manifest.documentCount, 3);
  assert.equal(manifest.traversal.visitedCount, 3);
  assert.equal(manifest.complete, true);
  // the back-edge is preserved as dependency info
  assert.deepEqual(entryById(manifest).get("c")!.dependsOn.map((d) => d.cadDocumentId), ["a"]);
});

test("a malformed self-edge does not loop and is not emitted as a dependency", async () => {
  const g = new Graph().doc("a").doc("b").edge("a", "a").edge("a", "b");
  g.version("a", 1);
  g.version("b", 1);
  const manifest = await buildGetLatestManifest("a", g.deps());
  assert.equal(manifest.documentCount, 2);
  assert.deepEqual(entryById(manifest).get("a")!.dependsOn.map((d) => d.cadDocumentId), ["b"]);
});

test("a dependency on a document outside the tenant is reported as dangling, never leaked", async () => {
  const g = new Graph()
    .doc("a", { cadType: "IAM" })
    .doc("b")
    .foreignDoc("secret") // exists, but not in this tenant
    .edge("a", "b")
    .edge("b", "secret");
  g.version("a", 1);
  g.version("b", 1);

  const manifest = await buildGetLatestManifest("a", g.deps());

  assert.equal(manifest.complete, false);
  assert.equal(manifest.documentCount, 2, "the foreign document is not in the manifest");
  assert.ok(!manifest.entries.some((e) => e.cadDocumentId === "secret"));
  assert.ok(
    !JSON.stringify(manifest).includes("FOREIGN-secret"),
    "foreign document metadata never leaks into the manifest",
  );
  const dangling = manifest.problems.find((p) => p.kind === "dangling-dependency");
  assert.ok(dangling);
  assert.equal(dangling!.cadDocumentId, "b");
  assert.deepEqual(dangling!.cadDocumentIds, ["secret"]);
  assert.ok(entryById(manifest).get("b")!.problems.includes("dangling-dependency"));
});

// ------------------------------------------------------------
// bounded traversal
// ------------------------------------------------------------

test("traversal throws when the graph exceeds the node cap", async () => {
  const g = new Graph().doc("a").doc("b").doc("c").doc("d");
  g.edge("a", "b").edge("b", "c").edge("c", "d");
  for (const id of ["a", "b", "c", "d"]) g.version(id, 1);

  await assert.rejects(
    () => buildGetLatestManifest("a", g.deps({ maxNodes: 2 })),
    CadGraphTooLargeError,
  );

  // exactly at the cap is fine
  const ok = await buildGetLatestManifest("a", g.deps({ maxNodes: 4 }));
  assert.equal(ok.documentCount, 4);
});

// ------------------------------------------------------------
// path collision between different documents
// ------------------------------------------------------------

test("case-insensitive workspace-path collisions are reported, not auto-renamed", async () => {
  const g = new Graph()
    .doc("a", { cadType: "IAM", fileName: "Top.iam" })
    .doc("b", { documentNumber: "B-0001", fileName: "Bracket.ipt" })
    .doc("c", { documentNumber: "C-0002", fileName: "bracket.IPT" })
    .edge("a", "b")
    .edge("a", "c");
  for (const id of ["a", "b", "c"]) g.version(id, 1);

  const manifest = await buildGetLatestManifest("a", g.deps());

  assert.equal(manifest.complete, false);
  const collision = manifest.problems.find((p) => p.kind === "path-collision");
  assert.ok(collision);
  assert.deepEqual(collision!.cadDocumentIds, ["b", "c"]);

  const byId = entryById(manifest);
  // paths are NOT changed - both keep their derived name
  assert.equal(byId.get("b")!.workspacePath, "Bracket.ipt");
  assert.equal(byId.get("c")!.workspacePath, "bracket.IPT");
  assert.ok(byId.get("b")!.problems.includes("path-collision"));
  assert.ok(byId.get("c")!.problems.includes("path-collision"));
});

// ------------------------------------------------------------
// root lookup
// ------------------------------------------------------------

test("an unknown / cross-tenant root throws RootCadDocumentNotFoundError", async () => {
  const g = new Graph().doc("a");
  g.version("a", 1);
  await assert.rejects(
    () => buildGetLatestManifest("does-not-exist", g.deps()),
    RootCadDocumentNotFoundError,
  );

  const g2 = new Graph().foreignDoc("other-org-doc");
  await assert.rejects(
    () => buildGetLatestManifest("other-org-doc", g2.deps()),
    RootCadDocumentNotFoundError,
  );
});

test("Get Latest never consults lifecycle / release state (deps expose none)", async () => {
  // The deps contract has no lifecycle input and the manifest has no such
  // field - this test locks that in structurally.
  const g = new Graph().doc("a");
  g.version("a", 1);
  const manifest = await buildGetLatestManifest("a", g.deps());
  const json = JSON.stringify(manifest);
  for (const forbidden of ["lifecycle", "released", "RELEASED", "revision", "baseline"]) {
    assert.ok(!json.includes(forbidden), `manifest must not mention ${forbidden}`);
  }
});
