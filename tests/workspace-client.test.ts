/**
 * Focused tests for the PDM reference "Get" CLI client (P3B-2C):
 * `cli/arch-session.ts`, `cli/http-content-downloader.ts`,
 * `cli/workspace-plan-client.ts`, `cli/orchestrate-workspace-get.ts`.
 *
 * These run against a REAL local HTTP server (a small fake Arch server built
 * on `node:http`) so cookies, streaming, redirects, and non-2xx handling are
 * exercised through actual sockets - not mocked at the fetch layer. This is
 * still a unit-test-speed suite; the live end-to-end run against the real
 * Next.js server + Postgres + storage is a separate, manual integration gate.
 *
 * Run with:  node --experimental-strip-types --test tests/workspace-client.test.ts
 * (also picked up by `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ArchAuthenticationError,
  assertSessionOriginMatches,
  loginWithCredentials,
  OriginMismatchError,
  type ArchSession,
} from "../cli/arch-session.ts";
import {
  ContentDownloadHttpError,
  ContentDownloadRedirectError,
  HttpContentDownloader,
  UnsafeContentPathError,
} from "../cli/http-content-downloader.ts";
import {
  fetchWorkspacePlan,
  WorkspacePlanRedirectError,
  WorkspacePlanRequestError,
} from "../cli/workspace-plan-client.ts";
import {
  assertHttpOrigin,
  InvalidServerUrlError,
  runWorkspaceGet,
} from "../cli/orchestrate-workspace-get.ts";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  resolveRequestTimeoutMs,
} from "../cli/request-timeout.ts";
import { isPasswordArgument, parseArgs } from "../cli/workspace-get.ts";
import {
  LocalWorkspaceFs,
  materializeWorkspacePlan,
  UnsafeWorkspacePlanError,
  UnsupportedWorkspaceContractError,
  WorkspaceRootError,
  type MaterializationReport,
} from "../app/lib/workspace-materialize-core.ts";
import {
  WORKSPACE_PLAN_CONTRACT_ID,
  WORKSPACE_PLAN_CONTRACT_VERSION,
  type WorkspacePlan,
  type WorkspacePlanEntry,
  type WorkspacePlanVersion,
} from "../app/lib/workspace-plan-core.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const FIXED_NOW = new Date("2026-09-07T00:00:00.000Z");

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-client-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------
// Fake Arch server: real sockets, configurable per-test behavior
// ------------------------------------------------------------

interface ContentBehavior {
  bytes?: Buffer;
  status?: number;
  redirect?: boolean;
  chunkSize?: number;
  /** Send 200 + headers (and, optionally, a few bytes) then never finish the
   *  response - simulates a stalled/hung connection for timeout tests. */
  stall?: boolean;
}

class FakeArchServer {
  readonly server: http.Server;
  readonly requestLog: string[] = [];
  readonly validEmail = "itest-client@example.test";
  readonly validPassword = "Itest-P3B-2C-2026!";
  readonly sessionCookieValue = `sess-${randomBytes(8).toString("hex")}`;
  readonly csrfCookieValue = `csrf-${randomBytes(8).toString("hex")}`;

  readonly plans = new Map<string, unknown>();
  readonly planStatus = new Map<string, number>();
  readonly planRedirect = new Set<string>();
  readonly planStall = new Set<string>();
  readonly content = new Map<string, ContentBehavior>();

  #origin = "";

  constructor() {
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.#origin = `http://127.0.0.1:${address.port}`;
    return this.#origin;
  }

  async stop(): Promise<void> {
    // Some tests deliberately leave a connection hanging (to exercise the
    // client-side timeout); force those closed too instead of waiting on them.
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  #isAuthenticated(req: http.IncomingMessage): boolean {
    const cookie = req.headers.cookie ?? "";
    return cookie.includes(`authjs.session-token=${this.sessionCookieValue}`);
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    this.requestLog.push(url.pathname);

    if (url.pathname === "/api/auth/csrf" && req.method === "GET") {
      res.setHeader(
        "Set-Cookie",
        `authjs.csrf-token=${this.csrfCookieValue}; Path=/; HttpOnly`,
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ csrfToken: this.csrfCookieValue }));
      return;
    }

    if (url.pathname === "/api/auth/callback/credentials" && req.method === "POST") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const email = params.get("email");
        const password = params.get("password");
        const csrfToken = params.get("csrfToken");
        if (
          csrfToken === this.csrfCookieValue &&
          email === this.validEmail &&
          password === this.validPassword
        ) {
          res.setHeader(
            "Set-Cookie",
            `authjs.session-token=${this.sessionCookieValue}; Path=/; HttpOnly`,
          );
          res.setHeader("content-type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify({ url: "/" }));
        } else {
          res.statusCode = 401;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "invalid credentials" }));
        }
      });
      return;
    }

    const planMatch = /^\/api\/cad-documents\/([^/]+)\/workspace-plan$/.exec(
      url.pathname,
    );
    if (planMatch) {
      if (!this.#isAuthenticated(req)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
      }
      const id = planMatch[1];
      if (this.planStall.has(id)) {
        // Never respond at all - simulates a hung server for timeout tests.
        return;
      }
      if (this.planRedirect.has(id)) {
        res.statusCode = 302;
        res.setHeader("Location", "http://evil.example.com/hijacked-plan");
        res.end();
        return;
      }
      const status = this.planStatus.get(id);
      if (status) {
        res.statusCode = status;
        res.end(JSON.stringify({ error: "server error" }));
        return;
      }
      const plan = this.plans.get(id);
      if (!plan) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(plan));
      return;
    }

    const contentMatch = /^\/api\/file-versions\/([^/]+)\/content$/.exec(
      url.pathname,
    );
    if (contentMatch) {
      if (!this.#isAuthenticated(req)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
      }
      const id = contentMatch[1];
      const behavior = this.content.get(id) ?? {};
      if (behavior.stall) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.flushHeaders();
        res.write(behavior.bytes ?? Buffer.from("partial"));
        // Deliberately never call res.end() - the connection just hangs.
        return;
      }
      if (behavior.redirect) {
        res.statusCode = 302;
        res.setHeader("Location", "http://evil.example.com/hijacked-bytes");
        res.end();
        return;
      }
      if (behavior.status) {
        res.statusCode = behavior.status;
        res.end("error");
        return;
      }
      const bytes = behavior.bytes ?? Buffer.alloc(0);
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      const chunkSize = behavior.chunkSize ?? Math.max(bytes.length, 1);
      let offset = 0;
      const writeNext = (): void => {
        if (offset >= bytes.length) {
          res.end();
          return;
        }
        const chunk = bytes.subarray(offset, offset + chunkSize);
        offset += chunkSize;
        res.write(chunk, () => setImmediate(writeNext));
      };
      writeNext();
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  }
}

// ------------------------------------------------------------
// WorkspacePlan fixtures
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

async function loginToFake(fake: FakeArchServer, origin: string): Promise<ArchSession> {
  return loginWithCredentials(origin, fake.validEmail, fake.validPassword);
}

// ------------------------------------------------------------
// Authentication (arch-session.ts)
// ------------------------------------------------------------

test("loginWithCredentials succeeds and yields a session with propagated cookies", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const session = await loginToFake(fake, origin);
    assert.equal(session.origin, origin);
    const headers = session.authHeaders();
    assert.ok(headers.cookie?.includes(`authjs.session-token=${fake.sessionCookieValue}`));
  } finally {
    await fake.stop();
  }
});

test("loginWithCredentials rejects a wrong password without ever exposing a session cookie", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    await assert.rejects(
      () => loginWithCredentials(origin, fake.validEmail, "wrong-password"),
      ArchAuthenticationError,
    );
  } finally {
    await fake.stop();
  }
});

// ------------------------------------------------------------
// Authenticated workspace-plan request + cookie propagation
// ------------------------------------------------------------

test("fetchWorkspacePlan sends the authenticated session's cookies and returns the plan", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const plan = makePlan([makeEntry()]);
    fake.plans.set("doc-a", plan);

    const session = await loginToFake(fake, origin);
    const fetched = await fetchWorkspacePlan(origin, "doc-a", session);
    assert.deepEqual(fetched, plan);
    assert.ok(fake.requestLog.includes("/api/cad-documents/doc-a/workspace-plan"));
  } finally {
    await fake.stop();
  }
});

test("an unauthenticated workspace-plan request is rejected (401 -> WorkspacePlanRequestError)", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set("doc-a", makePlan([makeEntry()]));
    const anonymous: ArchSession = { origin, authHeaders: () => ({}) };
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", anonymous),
      WorkspacePlanRequestError,
    );
  } finally {
    await fake.stop();
  }
});

// ------------------------------------------------------------
// Streaming content + exact contentPath usage + cookie propagation to
// content downloads
// ------------------------------------------------------------

test("HttpContentDownloader sends the session's cookies (auth propagated to content downloads)", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const content = Buffer.from("authenticated-bytes");
    fake.content.set("fv-a-1", { bytes: content });

    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session);
    const stream = await downloader.openContentStream("/api/file-versions/fv-a-1/content");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    assert.ok(Buffer.concat(chunks).equals(content));
  } finally {
    await fake.stop();
  }
});

test("an unauthenticated content download is rejected (401 -> ContentDownloadHttpError)", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.content.set("fv-a-1", { bytes: Buffer.from("secret") });
    const anonymous: ArchSession = { origin, authHeaders: () => ({}) };
    const downloader = new HttpContentDownloader(origin, anonymous);
    await assert.rejects(
      () => downloader.openContentStream("/api/file-versions/fv-a-1/content"),
      ContentDownloadHttpError,
    );
  } finally {
    await fake.stop();
  }
});

test("streaming content: a large multi-chunk response is consumed correctly end to end", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const content = randomBytes(2_000_003);
    fake.content.set("fv-big", { bytes: content, chunkSize: 16 * 1024 });

    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session);
    const stream = await downloader.openContentStream("/api/file-versions/fv-big/content");
    const chunks: Buffer[] = [];
    let chunkCount = 0;
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      chunkCount += 1;
    }
    assert.ok(Buffer.concat(chunks).equals(content));
    assert.ok(chunkCount > 1, "the body arrived as more than one chunk");
  } finally {
    await fake.stop();
  }
});

test("exact contentPath usage: the downloader requests precisely the given path, nothing else", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.content.set("fv-a-1", { bytes: Buffer.from("x") });
    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session);
    await downloader.openContentStream("/api/file-versions/fv-a-1/content");
    const contentRequests = fake.requestLog.filter((p) => p.includes("/content"));
    assert.deepEqual(contentRequests, ["/api/file-versions/fv-a-1/content"]);
  } finally {
    await fake.stop();
  }
});

test("non-2xx content response is rejected", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.content.set("fv-a-1", { status: 500 });
    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session);
    await assert.rejects(
      () => downloader.openContentStream("/api/file-versions/fv-a-1/content"),
      ContentDownloadHttpError,
    );
  } finally {
    await fake.stop();
  }
});

// ------------------------------------------------------------
// External URL / cross-origin rejection
// ------------------------------------------------------------

test("external URL rejection: an absolute or protocol-relative contentPath is refused before any network call", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session);
    const before = fake.requestLog.length;
    for (const badPath of [
      "https://evil.example.com/api/file-versions/fv-a-1/content",
      "//evil.example.com/api/file-versions/fv-a-1/content",
      "http://127.0.0.1/api/file-versions/fv-a-1/content",
      "/api/file-versions/fv-a-1/content?x=1",
      "/api/file-versions/fv-a-1/contents",
      "/../etc/passwd",
    ]) {
      await assert.rejects(
        () => downloader.openContentStream(badPath),
        UnsafeContentPathError,
        `expected ${badPath} to be refused`,
      );
    }
    assert.equal(fake.requestLog.length, before, "no request ever reached the server");
  } finally {
    await fake.stop();
  }
});

test("cross-origin redirect rejection: a content download redirect is refused", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.content.set("fv-a-1", { redirect: true });
    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session);
    await assert.rejects(
      () => downloader.openContentStream("/api/file-versions/fv-a-1/content"),
      ContentDownloadRedirectError,
    );
  } finally {
    await fake.stop();
  }
});

test("cross-origin redirect rejection: a workspace-plan redirect is refused", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.planRedirect.add("doc-a");
    const session = await loginToFake(fake, origin);
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", session),
      WorkspacePlanRedirectError,
    );
  } finally {
    await fake.stop();
  }
});

test("assertHttpOrigin refuses non-http(s) server URLs", () => {
  for (const bad of ["ftp://server", "file:///etc/passwd", "not a url", ""]) {
    assert.throws(() => assertHttpOrigin(bad), InvalidServerUrlError);
  }
  assert.equal(assertHttpOrigin("http://localhost:3000/"), "http://localhost:3000");
});

// ------------------------------------------------------------
// Unsafe plan / unsupported contract refusal
// ------------------------------------------------------------

test("unsafe plan refusal: fetchWorkspacePlan refuses a plan with safe !== true", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set(
      "doc-a",
      makePlan([makeEntry({ version: null, canMaterialize: false, blockedReasons: ["missing-version"] })], {
        safe: false,
      }),
    );
    const session = await loginToFake(fake, origin);
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", session),
      UnsafeWorkspacePlanError,
    );
  } finally {
    await fake.stop();
  }
});

test("unsupported contract refusal: wrong contract id is refused", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set(
      "doc-a",
      makePlan([makeEntry()], { contract: { id: "some-other-contract", version: "1.0.0" } }),
    );
    const session = await loginToFake(fake, origin);
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", session),
      UnsupportedWorkspaceContractError,
    );
  } finally {
    await fake.stop();
  }
});

test("unsupported contract refusal: unsupported contract major version is refused", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set(
      "doc-a",
      makePlan([makeEntry()], {
        contract: { id: WORKSPACE_PLAN_CONTRACT_ID, version: "99.0.0" },
      }),
    );
    const session = await loginToFake(fake, origin);
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", session),
      UnsupportedWorkspaceContractError,
    );
  } finally {
    await fake.stop();
  }
});

test("a malformed workspace-plan response body is refused", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set("doc-a", { nonsense: true });
    const session = await loginToFake(fake, origin);
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", session),
      WorkspacePlanRequestError,
    );
  } finally {
    await fake.stop();
  }
});

// ------------------------------------------------------------
// Orchestration: full end-to-end runs against the fake server
// ------------------------------------------------------------

test("relative workspace root refusal: rejected before any HTTP request is made", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set("doc-a", makePlan([makeEntry()]));
    const session = await loginToFake(fake, origin);
    const beforeCount = fake.requestLog.length;
    await assert.rejects(
      () =>
        runWorkspaceGet({
          serverUrl: origin,
          cadDocumentId: "doc-a",
          workspaceRoot: "relative/workspace",
          session,
        }),
      WorkspaceRootError,
    );
    assert.equal(fake.requestLog.length, beforeCount, "no request was made");
  } finally {
    await fake.stop();
  }
});

test("full orchestration: authenticated get -> real download -> managed local file", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeArchServer();
    const origin = await fake.start();
    try {
      const content = Buffer.from("full-orchestration-bytes");
      const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
      fake.plans.set("doc-a", makePlan([makeEntry({ version })]));
      fake.content.set(version.fileVersionId, { bytes: content });

      const session = await loginToFake(fake, origin);
      const report = await runWorkspaceGet({
        serverUrl: origin,
        cadDocumentId: "doc-a",
        workspaceRoot: dir,
        session,
      });

      assert.equal(report.results[0].status, "downloaded");
      const written = await readFile(path.join(dir, "Part.ipt"));
      assert.ok(written.equals(content));
      // No Get Latest re-resolution: only workspace-plan and content paths
      // were ever requested.
      assert.ok(!fake.requestLog.some((p) => p.includes("get-latest")));
    } finally {
      await fake.stop();
    }
  });
});

test("existing identical local file through orchestration => already-current, no re-download", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeArchServer();
    const origin = await fake.start();
    try {
      const content = Buffer.from("already-on-disk");
      const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
      fake.plans.set("doc-a", makePlan([makeEntry({ version })]));
      fake.content.set(version.fileVersionId, { bytes: content });
      await writeFile(path.join(dir, "Part.ipt"), content);

      const session = await loginToFake(fake, origin);
      const report = await runWorkspaceGet({
        serverUrl: origin,
        cadDocumentId: "doc-a",
        workspaceRoot: dir,
        session,
      });

      assert.equal(report.results[0].status, "already-current");
      assert.ok(!fake.requestLog.some((p) => p.includes("/content")));
    } finally {
      await fake.stop();
    }
  });
});

test("existing different local file through orchestration => blocked, never overwritten", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeArchServer();
    const origin = await fake.start();
    try {
      const pinned = Buffer.from("server-current-content");
      const localEdit = Buffer.from("a-local-unsaved-edit");
      const version = makeVersion({ checksum: sha256(pinned), fileSize: pinned.byteLength });
      fake.plans.set("doc-a", makePlan([makeEntry({ version })]));
      fake.content.set(version.fileVersionId, { bytes: pinned });
      await writeFile(path.join(dir, "Part.ipt"), localEdit);

      const session = await loginToFake(fake, origin);
      const report = await runWorkspaceGet({
        serverUrl: origin,
        cadDocumentId: "doc-a",
        workspaceRoot: dir,
        session,
      });

      assert.equal(report.results[0].status, "blocked");
      assert.match(report.results[0].reason ?? "", /local-conflict/);
      const stillLocalEdit = await readFile(path.join(dir, "Part.ipt"));
      assert.ok(stillLocalEdit.equals(localEdit));
      assert.ok(!fake.requestLog.some((p) => p.includes("/content")));
    } finally {
      await fake.stop();
    }
  });
});

test("checksum/size failure propagation: server bytes not matching the pinned version are reported as failed", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeArchServer();
    const origin = await fake.start();
    try {
      const pinned = Buffer.from("what-the-plan-expects");
      const wrong = Buffer.from("totally-different-bytes!!");
      const version = makeVersion({ checksum: sha256(pinned), fileSize: pinned.byteLength });
      fake.plans.set("doc-a", makePlan([makeEntry({ version })]));
      fake.content.set(version.fileVersionId, { bytes: wrong });

      const session = await loginToFake(fake, origin);
      const report = await runWorkspaceGet({
        serverUrl: origin,
        cadDocumentId: "doc-a",
        workspaceRoot: dir,
        session,
      });

      assert.equal(report.results[0].status, "failed");
      await assert.rejects(() => readFile(path.join(dir, "Part.ipt")));
    } finally {
      await fake.stop();
    }
  });
});

test("deterministic report across two runs against fresh workspaces", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const content = Buffer.from("deterministic-orchestration-bytes");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    fake.plans.set("doc-a", makePlan([makeEntry({ version })]));
    fake.content.set(version.fileVersionId, { bytes: content });

    const session = await loginToFake(fake, origin);
    const run = async (): Promise<MaterializationReport> =>
      withTmpDir(async (dir) => {
        const report = await runWorkspaceGet({
          serverUrl: origin,
          cadDocumentId: "doc-a",
          workspaceRoot: dir,
          session,
        });
        return { ...report, workspaceRoot: "<normalized>", startedAt: "<t>", finishedAt: "<t>" };
      });

    const [a, b] = await Promise.all([run(), run()]);
    assert.deepEqual(a, b);
  } finally {
    await fake.stop();
  }
});

// ------------------------------------------------------------
// Security fix #1 - bind authenticated session to exact origin
// ------------------------------------------------------------

test("assertSessionOriginMatches accepts exact/normalized matches and rejects everything else", () => {
  const session: ArchSession = { origin: "http://localhost:3000", authHeaders: () => ({}) };
  assert.doesNotThrow(() => assertSessionOriginMatches(session, "http://localhost:3000"));
  // Default-port normalization: both sides go through the URL parser.
  assert.doesNotThrow(() =>
    assertSessionOriginMatches(
      { origin: "http://localhost:3000/", authHeaders: () => ({}) },
      "http://localhost:3000",
    ),
  );
  for (const targetOrigin of [
    "http://localhost:3001", // different port
    "https://localhost:3000", // different scheme
    "http://evil.example.com:3000", // different host
    "not a url",
  ]) {
    assert.throws(() => assertSessionOriginMatches(session, targetOrigin), OriginMismatchError);
  }
});

test("cookies from origin A are never sent to origin B: fetchWorkspacePlan refuses cross-origin reuse", async () => {
  const fakeA = new FakeArchServer();
  const originA = await fakeA.start();
  const fakeB = new FakeArchServer();
  const originB = await fakeB.start();
  try {
    fakeB.plans.set("doc-a", makePlan([makeEntry()]));
    const sessionA = await loginToFake(fakeA, originA);

    await assert.rejects(
      () => fetchWorkspacePlan(originB, "doc-a", sessionA),
      OriginMismatchError,
    );
    // No request - authenticated or otherwise - ever reached server B.
    assert.deepEqual(fakeB.requestLog, []);
  } finally {
    await fakeA.stop();
    await fakeB.stop();
  }
});

test("cookies from origin A are never sent to origin B: HttpContentDownloader refuses cross-origin reuse", async () => {
  const fakeA = new FakeArchServer();
  const originA = await fakeA.start();
  const fakeB = new FakeArchServer();
  const originB = await fakeB.start();
  try {
    fakeB.content.set("fv-a-1", { bytes: Buffer.from("should never be reachable") });
    const sessionA = await loginToFake(fakeA, originA);

    const downloader = new HttpContentDownloader(originB, sessionA);
    await assert.rejects(
      () => downloader.openContentStream("/api/file-versions/fv-a-1/content"),
      OriginMismatchError,
    );
    assert.deepEqual(fakeB.requestLog, []);
  } finally {
    await fakeA.stop();
    await fakeB.stop();
  }
});

test("a session reused against its OWN origin still works normally (origin binding is not overly strict)", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.plans.set("doc-a", makePlan([makeEntry()]));
    const session = await loginToFake(fake, origin);
    const plan = await fetchWorkspacePlan(origin, "doc-a", session);
    assert.equal(plan.entries.length, 1);
  } finally {
    await fake.stop();
  }
});

// ------------------------------------------------------------
// Security fix #2 - reject every password-bearing CLI argument form
// ------------------------------------------------------------

test("isPasswordArgument recognizes every required form and nothing unrelated", () => {
  for (const form of ["--password", "--password=x", "--password=", "-p", "-pvalue", "-p=value"]) {
    assert.equal(isPasswordArgument(form), true, `expected ${form} to be a password argument`);
  }
  for (const form of ["--server", "--document", "--workspace", "-e", "--email", "-x", "positional"]) {
    assert.equal(isPasswordArgument(form), false, `expected ${form} to NOT be a password argument`);
  }
});

test("parseArgs rejects every password-bearing argument form with the exact generic message, never echoing the secret", () => {
  const secret = "SuperSecretValue-DoNotLeak-7f3a";
  const base = ["--server", "http://localhost:3000", "--document", "doc-a", "--workspace", "/w"];
  const forms: string[][] = [
    ["--password"],
    ["--password", secret],
    [`--password=${secret}`],
    ["-p"],
    ["-p", secret],
    [`-p${secret}`],
    [`-p=${secret}`],
  ];

  for (const form of forms) {
    let caught: unknown;
    try {
      parseArgs([...base, ...form]);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, `expected ${JSON.stringify(form)} to throw`);
    assert.equal(
      caught.message,
      "Password arguments are not allowed. Use ARCH_PASSWORD or interactive input.",
    );
    assert.ok(!caught.message.includes(secret), "error message must never contain the secret");
  }
});

test("spawned CLI process never prints a password-bearing argument's value to stdout or stderr", async () => {
  const secret = "TotallySecretPassword-42-DoNotLeak";
  const forms: string[][] = [
    ["--password", secret],
    [`--password=${secret}`],
    ["-p", secret],
    [`-p${secret}`],
    [`-p=${secret}`],
  ];

  for (const form of forms) {
    const argv = [
      "--experimental-strip-types",
      "cli/workspace-get.ts",
      "--server",
      "http://localhost:1",
      "--document",
      "doc-a",
      "--workspace",
      "C:\\nonexistent\\workspace",
      ...form,
    ];

    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(process.execPath, argv, {
        cwd: REPO_ROOT,
        timeout: 15_000,
        env: { ...process.env, ARCH_EMAIL: "", ARCH_PASSWORD: "" },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }

    assert.ok(!stdout.includes(secret), `secret leaked to stdout for ${JSON.stringify(form)}`);
    assert.ok(!stderr.includes(secret), `secret leaked to stderr for ${JSON.stringify(form)}`);
    assert.ok(
      stderr.includes("Password arguments are not allowed. Use ARCH_PASSWORD or interactive input."),
      `expected the generic rejection message in stderr for ${JSON.stringify(form)}, got: ${stderr}`,
    );
  }
});

// ------------------------------------------------------------
// Security fix #3 - shared request timeout
// ------------------------------------------------------------

test("resolveRequestTimeoutMs: sensible default and a clean, validated env override", () => {
  assert.equal(resolveRequestTimeoutMs({}), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs({ ARCH_REQUEST_TIMEOUT_MS: "5000" }), 5000);
  for (const bad of ["-5", "0", "abc", "", "  ", "5000.5"]) {
    assert.equal(
      resolveRequestTimeoutMs({ ARCH_REQUEST_TIMEOUT_MS: bad }),
      DEFAULT_REQUEST_TIMEOUT_MS,
      `expected ${JSON.stringify(bad)} to fall back to the default`,
    );
  }
});

test("workspace-plan fetch times out on a hung server: clear error, single request, no retry", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.planStall.add("doc-a");
    const session = await loginToFake(fake, origin);

    const startedAt = Date.now();
    await assert.rejects(
      () => fetchWorkspacePlan(origin, "doc-a", session, fetch, 100),
      RequestTimeoutError,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 5000, `expected a fast timeout, took ${elapsedMs}ms`);

    const planRequests = fake.requestLog.filter((p) => p.endsWith("/workspace-plan"));
    assert.equal(planRequests.length, 1, "no automatic retry");
  } finally {
    await fake.stop();
  }
});

test("content download times out mid-stream on a stalled connection: clear error on the stream", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    fake.content.set("fv-a-1", { stall: true });
    const session = await loginToFake(fake, origin);
    const downloader = new HttpContentDownloader(origin, session, fetch, 100);

    const stream = await downloader.openContentStream("/api/file-versions/fv-a-1/content");
    await assert.rejects(async () => {
      for await (const _chunk of stream) {
        // draining the stream until it errors
      }
    }, RequestTimeoutError);
  } finally {
    await fake.stop();
  }
});

test("a content-download timeout still runs P3B-2B staging cleanup and leaves no final file", async () => {
  await withTmpDir(async (dir) => {
    const fake = new FakeArchServer();
    const origin = await fake.start();
    try {
      const version = makeVersion({ fileVersionId: "fv-stall-1" });
      fake.content.set("fv-stall-1", { stall: true });
      const plan = makePlan([
        makeEntry({
          version: { ...version, contentPath: "/api/file-versions/fv-stall-1/content" },
        }),
      ]);

      const session = await loginToFake(fake, origin);
      const downloader = new HttpContentDownloader(origin, session, fetch, 100);
      const fs = new LocalWorkspaceFs(dir);

      const report = await materializeWorkspacePlan(plan, dir, { downloader, fs });

      assert.equal(report.results[0].status, "failed");
      assert.match(report.results[0].reason ?? "", /timed out/);
      await assert.rejects(() => readFile(path.join(dir, "Part.ipt")));
      assert.deepEqual(
        await readdir(path.join(dir, ".arch-materialize-staging")).catch(() => []),
        [],
        "staging must be cleaned up after a timeout, exactly like any other download failure",
      );
    } finally {
      await fake.stop();
    }
  });
});

test("timeout applies to a successful-but-slower-than-usual download without falsely tripping", async () => {
  const fake = new FakeArchServer();
  const origin = await fake.start();
  try {
    const content = Buffer.from("finishes well within the generous timeout");
    const version = makeVersion({ checksum: sha256(content), fileSize: content.byteLength });
    fake.content.set(version.fileVersionId, { bytes: content, chunkSize: 4 });
    const session = await loginToFake(fake, origin);
    // A generous timeout relative to how long this tiny transfer actually takes.
    const downloader = new HttpContentDownloader(origin, session, fetch, 5000);
    const stream = await downloader.openContentStream(version.contentPath);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    assert.ok(Buffer.concat(chunks).equals(content));
  } finally {
    await fake.stop();
  }
});
