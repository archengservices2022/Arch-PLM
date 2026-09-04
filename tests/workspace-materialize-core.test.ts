/**
 * Focused tests for the PDM Managed Workspace Materialization core (P3B-2B).
 *
 * Run with:  node --experimental-strip-types --test tests/workspace-materialize-core.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import {
  DownloadTooLargeError,
  LocalWorkspaceFs,
  UnsafeWorkspacePlanError,
  UnsupportedWorkspaceContractError,
  WorkspacePathEscapeError,
  WorkspaceRootError,
  materializeWorkspacePlan,
  resolveWithinWorkspaceRoot,
  type ContentDownloader,
  type MaterializationReport,
} from "../app/lib/workspace-materialize-core.ts";
import {
  WORKSPACE_PLAN_CONTRACT_ID,
  WORKSPACE_PLAN_CONTRACT_VERSION,
  type WorkspacePlan,
  type WorkspacePlanEntry,
  type WorkspacePlanVersion,
} from "../app/lib/workspace-plan-core.ts";

const FIXED_NOW = new Date("2026-09-06T00:00:00.000Z");

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-materialize-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stagingEntries(dir: string): Promise<string[]> {
  return readdir(path.join(dir, ".arch-materialize-staging")).catch(() => [] as string[]);
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

function makeVersion(overrides: Partial<WorkspacePlanVersion> = {}): WorkspacePlanVersion {
  const content = Buffer.from("default-fixture-content");
  return {
    fileVersionId: "fv-a-1",
    versionNumber: 1,
    checksum: sha256(content),
    fileSize: content.byteLength,
    originalFileName: "Part.ipt",
    contentPath: "/api/file-versions/fv-a-1/content",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<WorkspacePlanEntry> = {}): WorkspacePlanEntry {
  return {
    cadDocumentId: "doc-a",
    documentNumber: "DOC-A",
    fileName: "Part.ipt",
    cadType: "IPT",
    isRoot: true,
    placement: { generatedRelativePath: "Part.ipt" },
    dependsOn: [],
    canMaterialize: true,
    blockedReasons: [],
    version: makeVersion(),
    ...overrides,
  };
}

function makePlan(
  entries: WorkspacePlanEntry[],
  overrides: Partial<WorkspacePlan> = {},
): WorkspacePlan {
  return {
    contract: { id: WORKSPACE_PLAN_CONTRACT_ID, version: WORKSPACE_PLAN_CONTRACT_VERSION },
    root: { cadDocumentId: entries[0]?.cadDocumentId ?? "doc-a" },
    generatedAt: FIXED_NOW.toISOString(),
    documentCount: entries.length,
    safe: true,
    entries,
    problems: [],
    traversal: { visitedCount: entries.length, edgeCount: 0, maxNodes: 5000 },
    ...overrides,
  };
}

class FakeDownloader implements ContentDownloader {
  readonly calls: string[] = [];
  readonly responses = new Map<string, () => Readable>();

  respondWith(contentPath: string, factory: () => Readable): this {
    this.responses.set(contentPath, factory);
    return this;
  }

  async openContentStream(contentPath: string): Promise<Readable> {
    this.calls.push(contentPath);
    const factory = this.responses.get(contentPath);
    if (!factory) {
      throw new Error(`No fake response registered for ${contentPath}`);
    }
    return factory();
  }
}

function singleChunkStream(content: Buffer): Readable {
  return Readable.from([content]);
}

function chunkedStream(content: Buffer, chunkSize = 64 * 1024): Readable {
  return Readable.from(
    (function* () {
      let offset = 0;
      while (offset < content.length) {
        yield content.subarray(offset, offset + chunkSize);
        offset += chunkSize;
      }
    })(),
  );
}

function failingAfterStream(content: Buffer, errorAfterBytes: number): Readable {
  return Readable.from(
    (async function* () {
      yield content.subarray(0, errorAfterBytes);
      throw new Error("simulated network failure");
    })(),
  );
}

function makeDeps(downloader: FakeDownloader, workspaceRoot: string) {
  return { downloader, fs: new LocalWorkspaceFs(workspaceRoot), now: () => FIXED_NOW };
}

// ------------------------------------------------------------
// 1. Safe successful materialization + exact pinned version/contentPath used
// ------------------------------------------------------------

test("safe successful materialization: downloads, verifies and promotes the exact pinned file", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("hello-part-a-bytes");
    const version = makeVersion({
      fileVersionId: "fv-specific",
      checksum: sha256(content),
      fileSize: content.byteLength,
      contentPath: "/api/file-versions/fv-specific/content",
    });
    const entry = makeEntry({ version, placement: { generatedRelativePath: "Part.ipt" } });
    const plan = makePlan([entry]);

    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      singleChunkStream(content),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));

    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].status, "downloaded");
    assert.equal(report.results[0].cadDocumentId, "doc-a");
    assert.equal(report.results[0].fileVersionId, "fv-specific");
    assert.equal(report.results[0].checksum, sha256(content));
    assert.equal(report.results[0].bytesWritten, content.byteLength);
    assert.equal(report.summary.downloaded, 1);

    const written = await readFile(path.join(dir, "Part.ipt"));
    assert.ok(written.equals(content));

    // Exact pinned contentPath was used, nothing else.
    assert.deepEqual(downloader.calls, [version.contentPath]);

    assert.deepEqual(await stagingEntries(dir), [], "staging is cleaned up");
  });
});

test("no re-resolution of latest: each entry's own distinct contentPath is used, never shared/re-derived", async () => {
  await withTmpDir(async (dir) => {
    const contentA = Buffer.from("content-for-a");
    const contentB = Buffer.from("content-for-b-different-length!!");
    const versionA = makeVersion({
      fileVersionId: "fv-a-9",
      checksum: sha256(contentA),
      fileSize: contentA.byteLength,
      contentPath: "/api/file-versions/fv-a-9/content",
    });
    const versionB = makeVersion({
      fileVersionId: "fv-b-3",
      checksum: sha256(contentB),
      fileSize: contentB.byteLength,
      contentPath: "/api/file-versions/fv-b-3/content",
    });
    const entryA = makeEntry({
      cadDocumentId: "doc-a",
      version: versionA,
      placement: { generatedRelativePath: "A.ipt" },
    });
    const entryB = makeEntry({
      cadDocumentId: "doc-b",
      documentNumber: "DOC-B",
      isRoot: false,
      version: versionB,
      placement: { generatedRelativePath: "B.ipt" },
    });
    const plan = makePlan([entryA, entryB]);

    const downloader = new FakeDownloader()
      .respondWith(versionA.contentPath, () => singleChunkStream(contentA))
      .respondWith(versionB.contentPath, () => singleChunkStream(contentB));

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));

    assert.equal(report.summary.downloaded, 2);
    assert.deepEqual(new Set(downloader.calls), new Set([versionA.contentPath, versionB.contentPath]));
    assert.equal(downloader.calls.length, 2, "each pinned contentPath fetched exactly once");
  });
});

// ------------------------------------------------------------
// 2. Streamed download (no whole-file buffering assumption)
// ------------------------------------------------------------

test("streamed download: a multi-chunk source is consumed without a single whole-file read", async () => {
  await withTmpDir(async (dir) => {
    const content = randomBytes(500_003);
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      chunkedStream(content, 8192),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "downloaded");
    const written = await readFile(path.join(dir, "Part.ipt"));
    assert.ok(written.equals(content));
  });
});

test("large mock stream (~20MB, many small chunks) materializes correctly", async () => {
  await withTmpDir(async (dir) => {
    const content = randomBytes(20 * 1024 * 1024);
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      chunkedStream(content, 64 * 1024),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "downloaded");
    assert.equal(report.results[0].bytesWritten, content.byteLength);

    const written = await readFile(path.join(dir, "Part.ipt"));
    assert.equal(written.length, content.length);
    assert.ok(written.equals(content));
    assert.deepEqual(await stagingEntries(dir), []);
  });
});

// ------------------------------------------------------------
// 3. SHA mismatch / size mismatch -> failed, no leftover
// ------------------------------------------------------------

test("SHA mismatch: same size, different bytes -> failed, nothing promoted, staging cleaned", async () => {
  await withTmpDir(async (dir) => {
    const expected = Buffer.from("expected-bytes-1234");
    const wrong = Buffer.from("expected-bytes-9999"); // same length, different content
    assert.equal(expected.length, wrong.length);
    const version = makeVersion({ checksum: sha256(expected), fileSize: expected.byteLength });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      singleChunkStream(wrong),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "failed");
    assert.match(report.results[0].reason ?? "", /Integrity check failed/);

    await assert.rejects(() => readFile(path.join(dir, "Part.ipt")));
    assert.deepEqual(await stagingEntries(dir), []);
  });
});

test("size mismatch (too small): stream ends short -> failed", async () => {
  await withTmpDir(async (dir) => {
    const full = Buffer.from("this-is-the-full-expected-content");
    const short = full.subarray(0, full.length - 5);
    const version = makeVersion({ checksum: sha256(full), fileSize: full.byteLength });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      singleChunkStream(short),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "failed");
    assert.match(report.results[0].reason ?? "", /Integrity check failed/);
    await assert.rejects(() => readFile(path.join(dir, "Part.ipt")));
    assert.deepEqual(await stagingEntries(dir), []);
  });
});

test("size mismatch (too large): stream exceeds expected size mid-stream -> failed, aborted early", async () => {
  await withTmpDir(async (dir) => {
    const expectedSize = 1000;
    const tooMuch = randomBytes(5000);
    const version = makeVersion({ checksum: sha256(tooMuch.subarray(0, expectedSize)), fileSize: expectedSize });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      chunkedStream(tooMuch, 128),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "failed");
    await assert.rejects(() => readFile(path.join(dir, "Part.ipt")));
    assert.deepEqual(await stagingEntries(dir), []);
  });
});

// ------------------------------------------------------------
// 4. Partial download / failure cleanup
// ------------------------------------------------------------

test("partial download failure (network drop mid-stream): failed, temp cleaned, no final file", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("some-content-that-will-never-fully-arrive");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      failingAfterStream(content, 10),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "failed");
    assert.match(report.results[0].reason ?? "", /Download failed/);
    await assert.rejects(() => readFile(path.join(dir, "Part.ipt")));
    assert.deepEqual(await stagingEntries(dir), [], "no leftover temp artifacts");
  });
});

test("downloader itself throwing before any bytes -> failed cleanly", async () => {
  await withTmpDir(async (dir) => {
    const version = makeVersion();
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader(); // no response registered -> throws
    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "failed");
    assert.match(report.results[0].reason ?? "", /Download failed/);
  });
});

// ------------------------------------------------------------
// 5. Unsafe relative path / workspace-root escape attempts
// ------------------------------------------------------------

test("unsafe relative path (traversal) is blocked, nothing written anywhere", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry({ placement: { generatedRelativePath: "../../etc/passwd" } });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader();

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.equal(downloader.calls.length, 0, "never attempts to download an unsafe path");

    const parentOfDir = path.dirname(dir);
    const entries = await readdir(parentOfDir);
    // Nothing named "passwd" appeared next to (or above) the workspace root.
    assert.ok(!entries.includes("passwd"));
  });
});

test("workspace-root escape attempt via a drive-prefixed path is blocked", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry({
      placement: { generatedRelativePath: "C:/Windows/System32/evil.dll" },
    });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader();

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.equal(downloader.calls.length, 0);
  });
});

test("a Windows-reserved device name placement path is blocked (shared hardening propagates here)", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry({ placement: { generatedRelativePath: "COM1.ipt" } });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader();

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.equal(downloader.calls.length, 0);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test("a nested generatedRelativePath is rejected in this milestone - flat filenames only", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry({ placement: { generatedRelativePath: "Parts/Frame.ipt" } });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader();

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.match(report.results[0].reason ?? "", /nested paths are not supported/);
    assert.equal(downloader.calls.length, 0);
    // No "Parts" subdirectory (or anything else) was created.
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test("a backslash-nested generatedRelativePath is also rejected", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry({ placement: { generatedRelativePath: "Parts\\Frame.ipt" } });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader();

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.equal(downloader.calls.length, 0);
  });
});

test("a flat filename (no subfolder) still materializes normally", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("flat-file-content");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const entry = makeEntry({ version, placement: { generatedRelativePath: "Frame.ipt" } });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      singleChunkStream(content),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "downloaded");
    const written = await readFile(path.join(dir, "Frame.ipt"));
    assert.ok(written.equals(content));
  });
});

// ------------------------------------------------------------
// contentPath defense in depth: must exactly match the entry's own
// authenticated /api/file-versions/<fileVersionId>/content endpoint
// ------------------------------------------------------------

test("a contentPath naming a different fileVersionId is refused, never downloaded", async () => {
  await withTmpDir(async (dir) => {
    const version = makeVersion({
      fileVersionId: "fv-a-1",
      contentPath: "/api/file-versions/fv-SOMEONE-ELSES/content",
    });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      singleChunkStream(Buffer.from("should never be fetched")),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.match(report.results[0].reason ?? "", /untrusted contentPath/);
    assert.equal(downloader.calls.length, 0);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test("an arbitrary/absolute URL contentPath is refused, never downloaded", async () => {
  await withTmpDir(async (dir) => {
    for (const badContentPath of [
      "https://evil.example.com/api/file-versions/fv-a-1/content",
      "/api/file-versions/fv-a-1/content?download=1",
      "/api/file-versions/fv-a-1/contents",
      "/api/cad-documents/fv-a-1/get-latest",
      "//evil.example.com/api/file-versions/fv-a-1/content",
      "file:///etc/passwd",
      "/api/file-versions/fv-a-1/content/",
    ]) {
      const version = makeVersion({ fileVersionId: "fv-a-1", contentPath: badContentPath });
      const entry = makeEntry({ version });
      const plan = makePlan([entry]);
      const downloader = new FakeDownloader().respondWith(badContentPath, () =>
        singleChunkStream(Buffer.from("should never be fetched")),
      );

      const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
      assert.equal(
        report.results[0].status,
        "blocked",
        `expected contentPath ${JSON.stringify(badContentPath)} to be refused`,
      );
      assert.equal(downloader.calls.length, 0);
    }
  });
});

test("the exact expected contentPath shape is accepted and downloads normally", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("well-formed-content-path");
    const version = makeVersion({
      fileVersionId: "fv-good-1",
      checksum: sha256(content),
      fileSize: content.byteLength,
      contentPath: "/api/file-versions/fv-good-1/content",
    });
    const entry = makeEntry({ version });
    const plan = makePlan([entry]);
    const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
      singleChunkStream(content),
    );

    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "downloaded");
  });
});

test("resolveWithinWorkspaceRoot rejects traversal/absolute/drive-prefixed/nested paths directly", () => {
  const root = "C:\\Workspace\\Root";
  for (const bad of [
    "../evil.ipt",
    "a/../../evil.ipt",
    "/abs/evil.ipt",
    "C:/evil.ipt",
    "~/evil.ipt",
    "Sub/Part.ipt", // nested - not supported in this milestone
  ]) {
    assert.throws(() => resolveWithinWorkspaceRoot(root, bad), WorkspacePathEscapeError);
  }
  const ok = resolveWithinWorkspaceRoot(root, "Part.ipt");
  assert.ok(ok.toLowerCase().startsWith(root.toLowerCase()));
});

// ------------------------------------------------------------
// 6. Existing local file behavior
// ------------------------------------------------------------

test("existing identical file => already-current, no download attempted", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("already-on-disk-and-matching");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const entry = makeEntry({ version, placement: { generatedRelativePath: "Part.ipt" } });
    const plan = makePlan([entry]);
    await writeFile(path.join(dir, "Part.ipt"), content);

    const downloader = new FakeDownloader(); // must never be called
    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));

    assert.equal(report.results[0].status, "already-current");
    assert.equal(report.results[0].bytesWritten, 0);
    assert.equal(downloader.calls.length, 0);
    const stillThere = await readFile(path.join(dir, "Part.ipt"));
    assert.ok(stillThere.equals(content));
  });
});

test("existing different file => local conflict, never overwritten, no download attempted", async () => {
  await withTmpDir(async (dir) => {
    const pinnedContent = Buffer.from("what-the-server-thinks-is-current");
    const localEdit = Buffer.from("a-users-unsaved-local-edit-of-the-file");
    const version = makeVersion({ checksum: sha256(pinnedContent), fileSize: pinnedContent.byteLength });
    const entry = makeEntry({ version, placement: { generatedRelativePath: "Part.ipt" } });
    const plan = makePlan([entry]);
    await writeFile(path.join(dir, "Part.ipt"), localEdit);

    const downloader = new FakeDownloader(); // must never be called
    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));

    assert.equal(report.results[0].status, "blocked");
    assert.match(report.results[0].reason ?? "", /local-conflict/);
    assert.equal(downloader.calls.length, 0, "never downloads over a conflicting local file");

    const untouched = await readFile(path.join(dir, "Part.ipt"));
    assert.ok(untouched.equals(localEdit), "the local edit is preserved exactly");
  });
});

// ------------------------------------------------------------
// 7. Case-insensitive local path collision (defense in depth)
// ------------------------------------------------------------

test("case-insensitive path collision between two entries: both blocked, neither file written", async () => {
  await withTmpDir(async (dir) => {
    const entryA = makeEntry({
      cadDocumentId: "doc-a",
      placement: { generatedRelativePath: "Bracket.ipt" },
    });
    const entryB = makeEntry({
      cadDocumentId: "doc-b",
      documentNumber: "DOC-B",
      isRoot: false,
      version: makeVersion({ fileVersionId: "fv-b-1", contentPath: "/api/file-versions/fv-b-1/content" }),
      placement: { generatedRelativePath: "bracket.IPT" },
    });
    // Hand-built plan: this collision should never occur from the real
    // pipeline (workspace-plan-core.ts already blocks it), but materialize
    // must defend against it independently.
    const plan = makePlan([entryA, entryB]);

    const downloader = new FakeDownloader();
    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));

    const byId = new Map(report.results.map((r) => [r.cadDocumentId, r]));
    assert.equal(byId.get("doc-a")!.status, "blocked");
    assert.equal(byId.get("doc-b")!.status, "blocked");
    assert.match(byId.get("doc-a")!.reason ?? "", /local-path-collision/);
    assert.equal(downloader.calls.length, 0);

    const written = await readdir(dir).catch(() => []);
    assert.ok(!written.some((f) => f.toLowerCase() === "bracket.ipt"));
  });
});

// ------------------------------------------------------------
// 8. Unsafe plan / unsupported contract -> whole operation refused
// ------------------------------------------------------------

test("plan.safe !== true refuses the entire operation; nothing downloaded or written", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry();
    const plan = makePlan([entry], { safe: false });
    const downloader = new FakeDownloader().respondWith(entry.version!.contentPath, () =>
      singleChunkStream(Buffer.from("should never be fetched")),
    );

    await assert.rejects(
      () => materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir)),
      UnsafeWorkspacePlanError,
    );
    assert.equal(downloader.calls.length, 0);
    const entries = await readdir(dir).catch(() => []);
    assert.deepEqual(entries, []);
  });
});

test("unsupported contract id is refused", async () => {
  await withTmpDir(async (dir) => {
    const plan = makePlan([makeEntry()], { contract: { id: "some-other-contract", version: "1.0.0" } });
    const downloader = new FakeDownloader();
    await assert.rejects(
      () => materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir)),
      UnsupportedWorkspaceContractError,
    );
  });
});

test("unsupported contract version (major bump) is refused", async () => {
  await withTmpDir(async (dir) => {
    const plan = makePlan([makeEntry()], {
      contract: { id: WORKSPACE_PLAN_CONTRACT_ID, version: "2.0.0" },
    });
    const downloader = new FakeDownloader();
    await assert.rejects(
      () => materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir)),
      UnsupportedWorkspaceContractError,
    );
  });
});

test("a non-absolute workspace root is refused", async () => {
  const plan = makePlan([makeEntry()]);
  const downloader = new FakeDownloader();
  await assert.rejects(
    () =>
      materializeWorkspacePlan(plan, "relative/workspace", {
        downloader,
        fs: new LocalWorkspaceFs(path.resolve("relative/workspace")),
      }),
    WorkspaceRootError,
  );
});

// ------------------------------------------------------------
// 9. Defense in depth: a per-entry canMaterialize=false is honored even in
// a nominally-safe plan
// ------------------------------------------------------------

test("an entry with canMaterialize=false is blocked even though plan.safe is true", async () => {
  await withTmpDir(async (dir) => {
    const entry = makeEntry({
      canMaterialize: false,
      blockedReasons: ["missing-binary"],
      version: null,
    });
    const plan = makePlan([entry], { safe: true });
    const downloader = new FakeDownloader();
    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.equal(report.results[0].status, "blocked");
    assert.equal(downloader.calls.length, 0);
  });
});

// ------------------------------------------------------------
// 10. Deterministic result / report
// ------------------------------------------------------------

test("materialization report is deterministic across repeated runs against fresh workspaces", async () => {
  const content = Buffer.from("deterministic-content");
  const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
  const entryA = makeEntry({ cadDocumentId: "doc-a", version, placement: { generatedRelativePath: "A.ipt" } });
  const entryB = makeEntry({
    cadDocumentId: "doc-b",
    documentNumber: "DOC-B",
    isRoot: false,
    version,
    placement: { generatedRelativePath: "B.ipt" },
  });
  const plan = makePlan([entryA, entryB]);

  const run = async (): Promise<MaterializationReport> =>
    withTmpDir(async (dir) => {
      const downloader = new FakeDownloader().respondWith(version.contentPath, () =>
        singleChunkStream(content),
      );
      const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
      return { ...report, workspaceRoot: "<normalized>" };
    });

  const [reportA, reportB] = await Promise.all([run(), run()]);
  assert.deepEqual(reportA, reportB);
  assert.equal(JSON.stringify(reportA), JSON.stringify(reportB));
});

test("materialization report preserves plan.entries order deterministically", async () => {
  await withTmpDir(async (dir) => {
    const content = Buffer.from("x");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    const ids = ["doc-z", "doc-a", "doc-m"];
    const entries = ids.map((id, i) =>
      makeEntry({
        cadDocumentId: id,
        documentNumber: id.toUpperCase(),
        isRoot: i === 0,
        version: { ...version, fileVersionId: `fv-${id}`, contentPath: `/api/file-versions/fv-${id}/content` },
        placement: { generatedRelativePath: `${id}.ipt` },
      }),
    );
    const plan = makePlan(entries);
    const downloader = new FakeDownloader();
    for (const e of entries) {
      downloader.respondWith(e.version!.contentPath, () => singleChunkStream(content));
    }
    const report = await materializeWorkspacePlan(plan, dir, makeDeps(downloader, dir));
    assert.deepEqual(
      report.results.map((r) => r.cadDocumentId),
      ids,
    );
  });
});

// ------------------------------------------------------------
// LocalWorkspaceFs: staging cap enforcement (unit-level)
// ------------------------------------------------------------

test("LocalWorkspaceFs.stageDownload enforces maxBytes and cleans partial staging", async () => {
  await withTmpDir(async (dir) => {
    const fs = new LocalWorkspaceFs(dir);
    await assert.rejects(
      () => fs.stageDownload(chunkedStream(randomBytes(200_000), 4096), { maxBytes: 50_000 }),
      DownloadTooLargeError,
    );
    assert.deepEqual(await stagingEntries(dir), []);
  });
});

test("LocalWorkspaceFs.promote never overwrites an existing target", async () => {
  await withTmpDir(async (dir) => {
    const fs = new LocalWorkspaceFs(dir);
    const target = path.join(dir, "already-there.ipt");
    await writeFile(target, "pre-existing");

    const staged = await fs.stageDownload(singleChunkStream(Buffer.from("new-bytes")), {
      maxBytes: 1000,
    });
    await assert.rejects(() => fs.promote(staged, target));
    await fs.discardStaged(staged);

    const stillOriginal = await readFile(target, "utf8");
    assert.equal(stillOriginal, "pre-existing");
  });
});
