/**
 * Focused tests for the PDM Managed Workspace Plan core (P3B-2A,
 * provider-agnostic). Covers the pure transform
 * (`buildWorkspacePlanFromManifest`) directly against hand-built
 * `GetLatestManifest` fixtures, plus end-to-end composition against the real
 * `buildGetLatestManifest` traversal for nested/shared dependency scenarios.
 *
 * Run with:  node --experimental-strip-types --test tests/workspace-plan-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkspacePlanFromManifest,
  WORKSPACE_PLAN_CONTRACT_ID,
  WORKSPACE_PLAN_CONTRACT_VERSION,
  type WorkspacePlan,
} from "../app/lib/workspace-plan-core.ts";
import {
  buildGetLatestManifest,
  type GetLatestDeps,
  type GetLatestManifest,
  type ManifestDependencyEdge,
  type ManifestDocumentRow,
  type ManifestEntry,
  type ManifestVersionRow,
} from "../app/lib/get-latest-core.ts";

const FIXED_NOW = "2026-09-05T00:00:00.000Z";

// ------------------------------------------------------------
// Hand-built GetLatestManifest fixtures (unit-level, no traversal)
// ------------------------------------------------------------

function makeEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    cadDocumentId: "doc-a",
    documentNumber: "DOC-A",
    fileName: "PartA.ipt",
    cadType: "IPT",
    isRoot: true,
    workspacePath: "PartA.ipt",
    dependsOn: [],
    version: {
      fileVersionId: "fv-a-1",
      versionNumber: 1,
      checksum: "c-a-1",
      fileSize: 1000,
      originalFileName: "PartA.ipt",
      contentPath: "/api/file-versions/fv-a-1/content",
    },
    problems: [],
    ...overrides,
  };
}

function makeManifest(overrides: Partial<GetLatestManifest> = {}): GetLatestManifest {
  const entries = overrides.entries ?? [makeEntry()];
  return {
    root: { cadDocumentId: entries[0]?.cadDocumentId ?? "doc-a" },
    generatedAt: FIXED_NOW,
    documentCount: entries.length,
    complete: true,
    entries,
    problems: [],
    traversal: { visitedCount: entries.length, edgeCount: 0, maxNodes: 5000 },
    ...overrides,
  };
}

function entryById(plan: WorkspacePlan, id: string) {
  const found = plan.entries.find((e) => e.cadDocumentId === id);
  assert.ok(found, `expected entry ${id} to exist`);
  return found!;
}

// ------------------------------------------------------------
// Contract identity + versioning
// ------------------------------------------------------------

test("plan carries a stable contract id + semver version", () => {
  const plan = buildWorkspacePlanFromManifest(makeManifest());
  assert.equal(plan.contract.id, WORKSPACE_PLAN_CONTRACT_ID);
  assert.equal(plan.contract.version, WORKSPACE_PLAN_CONTRACT_VERSION);
  assert.match(plan.contract.version, /^\d+\.\d+\.\d+$/);
});

// ------------------------------------------------------------
// Determinism
// ------------------------------------------------------------

test("building the plan twice from the same manifest is byte-identical", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        dependsOn: [{ cadDocumentId: "doc-b", dependencyType: "COMPONENT" }],
      }),
      makeEntry({
        cadDocumentId: "doc-b",
        documentNumber: "DOC-B",
        fileName: "PartB.ipt",
        isRoot: false,
        workspacePath: "PartB.ipt",
        version: {
          fileVersionId: "fv-b-1",
          versionNumber: 1,
          checksum: "c-b-1",
          fileSize: 2000,
          originalFileName: "PartB.ipt",
          contentPath: "/api/file-versions/fv-b-1/content",
        },
      }),
    ],
    documentCount: 2,
  });

  const a = buildWorkspacePlanFromManifest(manifest);
  const b = buildWorkspacePlanFromManifest(manifest);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ------------------------------------------------------------
// Identity: cadDocumentId / fileVersionId are authoritative;
// filenames/paths are display-only, never identity
// ------------------------------------------------------------

test("exact version pinning: fileVersionId, checksum and fileSize pass through unchanged", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        version: {
          fileVersionId: "fv-specific-id",
          versionNumber: 7,
          checksum: "deadbeefcafef00d",
          fileSize: 123456,
          originalFileName: "Weird Name (1).ipt",
          contentPath: "/api/file-versions/fv-specific-id/content",
        },
      }),
    ],
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  const entry = entryById(plan, "doc-a");
  assert.equal(entry.canMaterialize, true);
  assert.deepEqual(entry.blockedReasons, []);
  assert.equal(entry.version!.fileVersionId, "fv-specific-id");
  assert.equal(entry.version!.versionNumber, 7);
  assert.equal(entry.version!.checksum, "deadbeefcafef00d");
  assert.equal(entry.version!.fileSize, 123456);
  assert.equal(
    entry.version!.contentPath,
    `/api/file-versions/${entry.version!.fileVersionId}/content`,
  );
  // Identity is cadDocumentId + fileVersionId; documentNumber/fileName are
  // separate, informational fields that must never be required for lookup.
  assert.equal(entry.cadDocumentId, "doc-a");
  assert.notEqual(entry.cadDocumentId, entry.documentNumber);
  assert.notEqual(entry.cadDocumentId, entry.fileName);
});

test("placement path is clearly generated, not an Inventor reference path, and never identity", () => {
  const manifest = makeManifest({
    entries: [makeEntry({ workspacePath: "PartA.ipt" })],
  });
  const plan = buildWorkspacePlanFromManifest(manifest);
  const entry = entryById(plan, "doc-a");
  assert.equal(entry.placement.generatedRelativePath, "PartA.ipt");
  // The contract has exactly one path-shaped field per entry (placement);
  // no field claiming to be an authoritative Inventor reference path exists.
  assert.ok(!("referencePath" in entry));
  assert.ok(!("inventorReferencePath" in entry));
  assert.ok(!("originalReferencePath" in entry));
});

// ------------------------------------------------------------
// Dependency relationships preserved
// ------------------------------------------------------------

test("parent -> child dependency relationships are preserved verbatim", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        dependsOn: [
          { cadDocumentId: "doc-b", dependencyType: "COMPONENT" },
          { cadDocumentId: "doc-c", dependencyType: "DRAWING_REFERENCE" },
        ],
      }),
      makeEntry({ cadDocumentId: "doc-b", documentNumber: "DOC-B", workspacePath: "b.ipt" }),
      makeEntry({ cadDocumentId: "doc-c", documentNumber: "DOC-C", workspacePath: "c.ipt" }),
    ],
    documentCount: 3,
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  assert.deepEqual(entryById(plan, "doc-a").dependsOn, [
    { cadDocumentId: "doc-b", dependencyType: "COMPONENT" },
    { cadDocumentId: "doc-c", dependencyType: "DRAWING_REFERENCE" },
  ]);
  assert.deepEqual(entryById(plan, "doc-b").dependsOn, []);
});

// ------------------------------------------------------------
// Missing version / missing binary -> unsafe, entry blocked
// ------------------------------------------------------------

test("missing-version blocks the entry and marks the whole plan unsafe", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        version: null,
        problems: ["missing-version"],
      }),
    ],
    complete: false,
    problems: [
      {
        kind: "missing-version",
        cadDocumentId: "doc-a",
        message: "No stored binary file version exists for DOC-A.",
      },
    ],
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  const entry = entryById(plan, "doc-a");
  assert.equal(entry.canMaterialize, false);
  assert.deepEqual(entry.blockedReasons, ["missing-version"]);
  assert.equal(entry.version, null);
  assert.equal(plan.safe, false);
  assert.ok(plan.problems.some((p) => p.kind === "missing-version"));
});

test("missing-binary blocks the entry and does not fall back silently", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        version: null,
        problems: ["missing-binary"],
      }),
    ],
    complete: false,
    problems: [
      {
        kind: "missing-binary",
        cadDocumentId: "doc-a",
        message: "The latest file version (V2) of DOC-A has no stored binary.",
      },
    ],
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  const entry = entryById(plan, "doc-a");
  assert.equal(entry.canMaterialize, false);
  assert.deepEqual(entry.blockedReasons, ["missing-binary"]);
  assert.equal(entry.version, null);
  assert.equal(plan.safe, false);
});

// ------------------------------------------------------------
// Path collisions -> unsafe, never auto-renamed
// ------------------------------------------------------------

test("a path collision blocks both colliding entries and never renames either", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        documentNumber: "DOC-A",
        workspacePath: "Bracket.ipt",
        problems: ["path-collision"],
      }),
      makeEntry({
        cadDocumentId: "doc-b",
        documentNumber: "DOC-B",
        isRoot: false,
        workspacePath: "bracket.IPT",
        problems: ["path-collision"],
        version: {
          fileVersionId: "fv-b-1",
          versionNumber: 1,
          checksum: "c-b-1",
          fileSize: 500,
          originalFileName: "bracket.IPT",
          contentPath: "/api/file-versions/fv-b-1/content",
        },
      }),
    ],
    documentCount: 2,
    complete: false,
    problems: [
      {
        kind: "path-collision",
        cadDocumentIds: ["doc-a", "doc-b"],
        workspacePath: "Bracket.ipt",
        message: "Multiple CAD documents resolve to the same workspace path.",
      },
    ],
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  const a = entryById(plan, "doc-a");
  const b = entryById(plan, "doc-b");
  assert.equal(a.canMaterialize, false);
  assert.equal(b.canMaterialize, false);
  assert.deepEqual(a.blockedReasons, ["path-collision"]);
  assert.deepEqual(b.blockedReasons, ["path-collision"]);
  // Paths are preserved exactly as given - never overwritten or renamed.
  assert.equal(a.placement.generatedRelativePath, "Bracket.ipt");
  assert.equal(b.placement.generatedRelativePath, "bracket.IPT");
  assert.equal(plan.safe, false);
});

// ------------------------------------------------------------
// Dangling dependency -> plan-level unsafe, but doesn't block the referrer's
// own (otherwise valid) file
// ------------------------------------------------------------

test("a dangling dependency makes the plan unsafe without blocking the referrer's own materializable file", () => {
  const manifest = makeManifest({
    entries: [
      makeEntry({
        cadDocumentId: "doc-a",
        dependsOn: [], // the dangling child never becomes a dependsOn entry
        problems: ["dangling-dependency"],
      }),
    ],
    complete: false,
    problems: [
      {
        kind: "dangling-dependency",
        cadDocumentId: "doc-a",
        cadDocumentIds: ["doc-ghost"],
        message: "doc-a depends on 1 CAD document(s) that are not available.",
      },
    ],
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  const a = entryById(plan, "doc-a");
  // doc-a's own file is fine - a dangling reference elsewhere doesn't block it.
  assert.equal(a.canMaterialize, true);
  assert.deepEqual(a.blockedReasons, []);
  // But the plan overall is unsafe/incomplete - a client cannot assume the
  // full dependency closure is satisfiable.
  assert.equal(plan.safe, false);
  assert.ok(plan.problems.some((p) => p.kind === "dangling-dependency"));
  assert.ok(!plan.entries.some((e) => e.cadDocumentId === "doc-ghost"));
});

// ------------------------------------------------------------
// Unsafe path re-validation (defense in depth, this layer's own concern)
// ------------------------------------------------------------

test("a workspace path that fails re-validation is blocked, not trusted or exposed", () => {
  const manifest = makeManifest({
    entries: [makeEntry({ cadDocumentId: "doc-a", workspacePath: "../../etc/passwd" })],
  });

  const plan = buildWorkspacePlanFromManifest(manifest);
  const entry = entryById(plan, "doc-a");
  assert.equal(entry.canMaterialize, false);
  assert.deepEqual(entry.blockedReasons, ["unsafe-path"]);
  assert.equal(entry.version, null, "an unsafe path blocks materialization even with a good version");
  assert.ok(!entry.placement.generatedRelativePath.includes(".."));
  assert.equal(plan.safe, false);
  assert.ok(plan.problems.some((p) => p.kind === "unsafe-path"));
});

test("an absolute workspace path is also caught by re-validation", () => {
  const manifest = makeManifest({
    entries: [makeEntry({ cadDocumentId: "doc-a", workspacePath: "/etc/shadow" })],
  });
  const plan = buildWorkspacePlanFromManifest(manifest);
  assert.deepEqual(entryById(plan, "doc-a").blockedReasons, ["unsafe-path"]);
  assert.equal(plan.safe, false);
});

test("a Windows-reserved device name path is caught by the same shared re-validation", () => {
  // Proves the Windows hardening added to assertSafeWorkspacePath propagates
  // here too, since this layer re-validates against the same shared rule.
  const manifest = makeManifest({
    entries: [makeEntry({ cadDocumentId: "doc-a", workspacePath: "COM1.ipt" })],
  });
  const plan = buildWorkspacePlanFromManifest(manifest);
  assert.deepEqual(entryById(plan, "doc-a").blockedReasons, ["unsafe-path"]);
  assert.equal(plan.safe, false);
});

// ------------------------------------------------------------
// No client-supplied input surface
// ------------------------------------------------------------

test("buildWorkspacePlanFromManifest takes only a manifest - no org id, storage key or path parameter exists", () => {
  assert.equal(buildWorkspacePlanFromManifest.length, 1);
});

// ------------------------------------------------------------
// Happy path (single document, root only)
// ------------------------------------------------------------

test("a fully resolved single-document plan is safe and materializable", () => {
  const plan = buildWorkspacePlanFromManifest(makeManifest());
  assert.equal(plan.safe, true);
  assert.equal(plan.documentCount, 1);
  const entry = entryById(plan, "doc-a");
  assert.equal(entry.isRoot, true);
  assert.equal(entry.canMaterialize, true);
  assert.deepEqual(entry.blockedReasons, []);
  assert.equal(plan.root.cadDocumentId, "doc-a");
});

// ------------------------------------------------------------
// End-to-end: real traversal (nested + shared dependencies) feeding the plan
// ------------------------------------------------------------

class Graph {
  readonly docs = new Map<string, ManifestDocumentRow>();
  readonly edges: ManifestDependencyEdge[] = [];
  readonly versions = new Map<string, ManifestVersionRow[]>();
  readonly objects = new Set<string>();

  doc(id: string, opts: { fileName?: string; cadType?: string } = {}): this {
    this.docs.set(id, {
      id,
      documentNumber: id.toUpperCase(),
      fileName: opts.fileName ?? `${id}.ipt`,
      cadType: opts.cadType ?? "IPT",
    });
    return this;
  }
  edge(parent: string, child: string, type = "COMPONENT"): this {
    this.edges.push({ parentDocumentId: parent, childDocumentId: child, dependencyType: type });
    return this;
  }
  version(id: string, versionNumber: number, present = true): this {
    const storageKey = `org/o/doc/${id}/v${versionNumber}/${id}${versionNumber}`;
    const list = this.versions.get(id) ?? [];
    list.push({
      id: `fv-${id}-${versionNumber}`,
      versionNumber,
      checksum: `c-${id}-${versionNumber}`,
      fileSize: 1000 + versionNumber,
      originalFileName: `${id}.ipt`,
      storageKey,
    });
    this.versions.set(id, list);
    if (present) this.objects.add(storageKey);
    return this;
  }
  deps(): GetLatestDeps {
    const self = this;
    return {
      now: () => new Date(FIXED_NOW),
      async loadDocuments(ids) {
        return ids.filter((id) => self.docs.has(id)).map((id) => ({ ...self.docs.get(id)! }));
      },
      async loadChildEdges(parentIds) {
        const wanted = new Set(parentIds);
        return self.edges.filter((e) => wanted.has(e.parentDocumentId)).map((e) => ({ ...e }));
      },
      async loadVersionsNewestFirst(id) {
        return [...(self.versions.get(id) ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);
      },
      async objectExists(key) {
        return self.objects.has(key);
      },
    };
  }
}

test("end-to-end: nested + shared dependencies produce a deterministic, safe plan", async () => {
  const g = new Graph()
    .doc("root", { cadType: "IAM", fileName: "Top.iam" })
    .doc("sub1", { cadType: "IAM", fileName: "Sub1.iam" })
    .doc("sub2", { cadType: "IAM", fileName: "Sub2.iam" })
    .doc("shared", { fileName: "Shared.ipt" })
    .edge("root", "sub1")
    .edge("root", "sub2")
    .edge("sub1", "shared")
    .edge("sub2", "shared"); // shared reached via two paths
  for (const id of ["root", "sub1", "sub2", "shared"]) g.version(id, 1);

  const manifest = await buildGetLatestManifest("root", g.deps());
  const plan = buildWorkspacePlanFromManifest(manifest);

  assert.equal(plan.safe, true);
  assert.equal(plan.documentCount, 4);
  assert.equal(plan.entries.filter((e) => e.cadDocumentId === "shared").length, 1);
  assert.ok(plan.entries.every((e) => e.canMaterialize));

  const plan2 = buildWorkspacePlanFromManifest(await buildGetLatestManifest("root", g.deps()));
  const stripDates = (p: WorkspacePlan) => ({ ...p, generatedAt: "" });
  assert.deepEqual(stripDates(plan), stripDates(plan2));
});

test("end-to-end: a document with a missing binary makes the plan unsafe with no fallback", async () => {
  const g = new Graph()
    .doc("root", { cadType: "IAM" })
    .doc("child")
    .edge("root", "child");
  g.version("root", 1);
  g.version("child", 1); // present
  g.version("child", 2, false); // latest metadata exists, bytes missing

  const manifest = await buildGetLatestManifest("root", g.deps());
  const plan = buildWorkspacePlanFromManifest(manifest);

  assert.equal(plan.safe, false);
  const child = entryById(plan, "child");
  assert.equal(child.canMaterialize, false);
  assert.deepEqual(child.blockedReasons, ["missing-binary"]);
  assert.equal(child.version, null, "must not fall back to the older, still-present V1");
});
