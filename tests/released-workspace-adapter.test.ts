/**
 * Focused tests proving `cli/released-workspace-adapter.ts` correctly
 * bridges a `ReleasedWorkspacePlan` (P3D-2) into the EXACT `WorkspacePlan`
 * shape the EXISTING, UNMODIFIED P3B-2B materializer already knows how to
 * consume - i.e. that "compatibility with existing safe workspace
 * materialization" holds for real, not just by type-checking.
 *
 * These are the same materializer invariants `workspace-materialize-core.test.ts`
 * already proves for a WORKING plan; this file proves they are UNCHANGED
 * (not weakened, not bypassed) when the input arrives via the released-plan
 * adapter instead: local-conflict behavior, "already-current" detection,
 * and tampered-download hash/size verification.
 *
 * Run with:  node --experimental-strip-types --test tests/released-workspace-adapter.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  LocalWorkspaceFs,
  materializeWorkspacePlan,
  type ContentDownloader,
} from "../app/lib/workspace-materialize-core.ts";
import type { WorkspacePlanVersion } from "../app/lib/workspace-plan-core.ts";
import {
  RELEASED_WORKSPACE_CONTRACT_ID,
  RELEASED_WORKSPACE_CONTRACT_VERSION,
  type ReleasedWorkspacePlan,
  type ReleasedWorkspacePlanEntry,
} from "../app/lib/released-workspace-core.ts";
import { toMaterializableWorkspacePlan } from "../cli/released-workspace-adapter.ts";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-released-adapter-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeVersion(overrides: Partial<WorkspacePlanVersion> = {}): WorkspacePlanVersion {
  const content = Buffer.from("released-fixture-content-v1");
  return {
    fileVersionId: "fv-released-1",
    versionNumber: 1,
    checksum: sha256(content),
    fileSize: content.byteLength,
    originalFileName: "Part.ipt",
    contentPath: "/api/file-versions/fv-released-1/content",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ReleasedWorkspacePlanEntry> = {}): ReleasedWorkspacePlanEntry {
  return {
    cadDocumentId: "doc-a",
    documentNumber: "DOC-A",
    fileName: "Part.ipt",
    cadType: "IPT",
    isRoot: false,
    inclusionKind: "DIRECT",
    placement: { generatedRelativePath: "Part.ipt" },
    dependsOn: [],
    canMaterialize: true,
    blockedReasons: [],
    version: makeVersion(),
    ...overrides,
  };
}

function makeReleasedPlan(entries: ReleasedWorkspacePlanEntry[]): ReleasedWorkspacePlan {
  return {
    contract: { id: RELEASED_WORKSPACE_CONTRACT_ID, version: RELEASED_WORKSPACE_CONTRACT_VERSION },
    itemRevision: { id: "rev-1" },
    releaseBaseline: { id: "rb-1", createdAt: new Date().toISOString(), createdById: "user-1" },
    generatedAt: new Date().toISOString(),
    documentCount: entries.length,
    safe: true,
    entries,
    problems: [],
  };
}

class FakeDownloader implements ContentDownloader {
  readonly responses = new Map<string, () => Readable>();
  respondWith(contentPath: string, factory: () => Readable): this {
    this.responses.set(contentPath, factory);
    return this;
  }
  async openContentStream(contentPath: string): Promise<Readable> {
    const factory = this.responses.get(contentPath);
    if (!factory) throw new Error(`No fake response registered for ${contentPath}`);
    return factory();
  }
}

// ------------------------------------------------------------
// Adapter shape
// ------------------------------------------------------------

test("adapter produces the exact WorkspacePlan contract id/version the materializer requires", () => {
  const plan = toMaterializableWorkspacePlan(makeReleasedPlan([makeEntry()]));
  assert.equal(plan.contract.id, "arch-plm.cad-workspace-plan");
  assert.equal(plan.safe, true);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.root.cadDocumentId, "rev-1", "root is repurposed to the ItemRevision id - documented, never real identity");
});

// ------------------------------------------------------------
// Full materialization through the adapter (successful download)
// ------------------------------------------------------------

test("released plan materializes successfully through the unmodified materializer via the adapter", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("released-fixture-content-v1");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const released = makeReleasedPlan([makeEntry({ version })]);
    const plan = toMaterializableWorkspacePlan(released);

    const downloader = new FakeDownloader().respondWith(version.contentPath, () => Readable.from([content]));
    const report = await materializeWorkspacePlan(plan, dir, {
      downloader,
      fs: new LocalWorkspaceFs(dir),
    });

    assert.equal(report.summary.downloaded, 1);
    assert.equal(report.results[0]!.status, "downloaded");
    assert.equal(report.results[0]!.checksum, sha256(content));
  });
});

// ------------------------------------------------------------
// 13. existing identical pinned file => already-current (unchanged)
// ------------------------------------------------------------

test("existing identical local file => already-current, no re-download (unchanged via the adapter)", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("released-fixture-content-v1");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    await writeFile(path.join(dir, "Part.ipt"), content);

    const plan = toMaterializableWorkspacePlan(makeReleasedPlan([makeEntry({ version })]));
    const downloader = new FakeDownloader(); // no response registered - must not be called
    const report = await materializeWorkspacePlan(plan, dir, {
      downloader,
      fs: new LocalWorkspaceFs(dir),
    });

    assert.equal(report.results[0]!.status, "already-current");
    assert.equal(report.summary.alreadyCurrent, 1);
  });
});

// ------------------------------------------------------------
// 12. local conflict behavior unchanged (never overwrites a different file)
// ------------------------------------------------------------

test("existing DIFFERENT local file => local conflict, never overwritten (unchanged via the adapter)", async () => {
  await withTmpDir(async (dir) => {
    const pinnedContent = Buffer.from("released-fixture-content-v1");
    const version = makeVersion({ checksum: sha256(pinnedContent), fileSize: pinnedContent.byteLength });
    const localDifferentContent = Buffer.from("a locally edited, different file");
    await writeFile(path.join(dir, "Part.ipt"), localDifferentContent);

    const plan = toMaterializableWorkspacePlan(makeReleasedPlan([makeEntry({ version })]));
    const downloader = new FakeDownloader(); // must not be called - conflict detected before download
    const report = await materializeWorkspacePlan(plan, dir, {
      downloader,
      fs: new LocalWorkspaceFs(dir),
    });

    assert.equal(report.results[0]!.status, "blocked");
    assert.match(report.results[0]!.reason ?? "", /local-conflict/);

    const stillLocal = await import("node:fs/promises").then((fs) => fs.readFile(path.join(dir, "Part.ipt")));
    assert.deepEqual(stillLocal, localDifferentContent, "the local file must never be overwritten");
  });
});

// ------------------------------------------------------------
// 14. tampered downloaded binary fails hash/size verification (unchanged)
// ------------------------------------------------------------

test("tampered/corrupt download fails hash verification and is never promoted (unchanged via the adapter)", async () => {
  await withTmpDir(async (dir) => {
    const expectedContent = Buffer.from("released-fixture-content-v1");
    const version = makeVersion({ checksum: sha256(expectedContent), fileSize: expectedContent.byteLength });
    // Same LENGTH as the pinned fileSize, different bytes - isolates the
    // SHA-256 mismatch check from the separate (also-tested-elsewhere)
    // size-bound abort.
    const tamperedContent = Buffer.from("tampered-fixture-content-v1".slice(0, expectedContent.byteLength).padEnd(expectedContent.byteLength, "x"));

    const plan = toMaterializableWorkspacePlan(makeReleasedPlan([makeEntry({ version })]));
    const downloader = new FakeDownloader().respondWith(version.contentPath, () => Readable.from([tamperedContent]));
    const report = await materializeWorkspacePlan(plan, dir, {
      downloader,
      fs: new LocalWorkspaceFs(dir),
    });

    assert.equal(report.results[0]!.status, "failed");
    assert.match(report.results[0]!.reason ?? "", /Integrity check failed/);

    const exists = await import("node:fs/promises").then((fs) =>
      fs.access(path.join(dir, "Part.ipt")).then(() => true).catch(() => false),
    );
    assert.equal(exists, false, "a failed integrity check must never leave a promoted file");
  });
});
