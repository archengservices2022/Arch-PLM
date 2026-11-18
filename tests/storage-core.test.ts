/**
 * Focused tests for the PDM storage core (provider-agnostic).
 *
 * Run with:  node --experimental-strip-types --test tests/storage-core.test.ts
 * (also picked up by `node --test tests/`).
 *
 * These files are excluded from the Next.js build / tsconfig / eslint on
 * purpose - they are executed by the Node test runner, not bundled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import {
  assertSafeRelativeKey,
  EmptyUploadError,
  fileVersionStorageKey,
  LocalFilesystemStorage,
  MAX_UPLOAD_ATTEMPTS,
  normalizeOriginalFileName,
  resolveMaxUploadBytes,
  resolveStorageRoot,
  sha256Hex,
  StorageObjectExistsError,
  StorageObjectNotFoundError,
  uploadCadFileVersion,
  UploadTooLargeError,
  UnsafeStorageKeyError,
  type StagedUpload,
  type StorageProvider,
  type UploadDeps,
} from "../app/lib/storage-core.ts";

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdm-storage-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A source stream that yields `total` bytes in small chunks, so cap
 *  enforcement is exercised mid-stream rather than on a single buffer. */
function chunkedSource(total: number, chunkSize = 64 * 1024): Readable {
  return Readable.from(
    (function* () {
      let remaining = total;
      while (remaining > 0) {
        const n = Math.min(chunkSize, remaining);
        remaining -= n;
        yield randomBytes(n);
      }
    })(),
  );
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function stagingEntries(dir: string): Promise<string[]> {
  return readdir(path.join(dir, ".staging")).catch(() => [] as string[]);
}

// ------------------------------------------------------------
// SHA-256
// ------------------------------------------------------------

test("sha256Hex matches the known 'abc' vector", () => {
  assert.equal(
    sha256Hex(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex(Buffer.alloc(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

// ------------------------------------------------------------
// Key safety
// ------------------------------------------------------------

test("assertSafeRelativeKey accepts server-shaped keys", () => {
  assert.doesNotThrow(() =>
    assertSafeRelativeKey("org/clx1/doc/cly2/v1/deadbeefdeadbeef"),
  );
  assert.doesNotThrow(() => assertSafeRelativeKey("a.b-c_D/1/2"));
});

test("assertSafeRelativeKey rejects traversal / absolute / unsafe input", () => {
  const bad = [
    "",
    "..",
    "../x",
    "a/../b",
    "a/./b",
    "./a",
    "a//b",
    "/abs/path",
    "~/home",
    "C:/windows",
    "a\\b",
    "..\\..\\x",
    `a/${NUL}/b`,
    `a/${BELL}/b`,
    "a/ /b",
    "a/b ",
    "a/@evil",
    "a/.hidden",
  ];
  for (const key of bad) {
    assert.throws(
      () => assertSafeRelativeKey(key),
      UnsafeStorageKeyError,
      `expected ${JSON.stringify(key)} to be rejected`,
    );
  }
});

test("fileVersionStorageKey is server-shaped, safe and encodes the version", () => {
  const key = fileVersionStorageKey({
    organizationId: "orgAAA",
    cadDocumentId: "docBBB",
    versionNumber: 7,
    uploadNonce: "0011223344556677",
  });
  assert.equal(key, "org/orgAAA/doc/docBBB/v7/0011223344556677");
  assert.doesNotThrow(() => assertSafeRelativeKey(key));

  const other = fileVersionStorageKey({
    organizationId: "orgAAA",
    cadDocumentId: "docBBB",
    versionNumber: 7,
    uploadNonce: "aabbccddeeff0011",
  });
  assert.notEqual(key, other, "different nonce -> different key");

  assert.throws(() =>
    fileVersionStorageKey({
      organizationId: "o",
      cadDocumentId: "d",
      versionNumber: 0,
      uploadNonce: "x",
    }),
  );
});

test("normalizeOriginalFileName strips path, control chars, leading dots", () => {
  assert.equal(normalizeOriginalFileName("../../etc/passwd"), "passwd");
  assert.equal(normalizeOriginalFileName("C:\\x\\y\\part.ipt"), "part.ipt");
  assert.equal(normalizeOriginalFileName(`a${NUL}${BELL}b.iam`), "ab.iam");
  assert.equal(normalizeOriginalFileName("...hidden"), "hidden");
  assert.equal(normalizeOriginalFileName(""), "upload.bin");
  assert.equal(normalizeOriginalFileName(null), "upload.bin");
  assert.equal(normalizeOriginalFileName("x".repeat(400)).length, 255);
});

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------

test("resolveStorageRoot defaults and honours PDM_STORAGE_ROOT", () => {
  assert.equal(
    resolveStorageRoot({}, "/work/app"),
    path.resolve("/work/app", ".pdm-storage"),
  );
  assert.equal(
    resolveStorageRoot({ PDM_STORAGE_ROOT: "  /var/pdm  " }, "/work/app"),
    path.resolve("/var/pdm"),
  );
  assert.equal(
    resolveStorageRoot({ PDM_STORAGE_ROOT: "relative/dir" }, "/work/app"),
    path.resolve("/work/app", "relative/dir"),
  );
});

test("resolveMaxUploadBytes defaults and honours a positive override", () => {
  assert.equal(resolveMaxUploadBytes({}), 250 * 1024 * 1024);
  assert.equal(resolveMaxUploadBytes({ PDM_MAX_UPLOAD_BYTES: "1048576" }), 1048576);
  assert.equal(
    resolveMaxUploadBytes({ PDM_MAX_UPLOAD_BYTES: "-5" }),
    250 * 1024 * 1024,
  );
  assert.equal(
    resolveMaxUploadBytes({ PDM_MAX_UPLOAD_BYTES: "nonsense" }),
    250 * 1024 * 1024,
  );
});

// ------------------------------------------------------------
// LocalFilesystemStorage: put/get immutability
// ------------------------------------------------------------

test("LocalFilesystemStorage round-trips bytes exactly", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    for (const size of [0, 1, 4096, 256 * 1024, 1_000_003]) {
      const data = randomBytes(size);
      const key = `org/o/doc/d/v1/${randomBytes(8).toString("hex")}`;
      await storage.put(key, data);
      const read = await storage.get(key);
      assert.ok(read.equals(data), `byte-for-byte round trip failed at ${size}`);
    }
  });
});

test("LocalFilesystemStorage.put enforces immutability via an exclusive link", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const key = "org/o/doc/d/v1/aaaa";
    const first = randomBytes(64);
    await storage.put(key, first);
    await assert.rejects(
      () => storage.put(key, randomBytes(64)),
      StorageObjectExistsError,
    );
    assert.ok((await storage.get(key)).equals(first));
    // No leftover temp files next to the target.
    const entries = await readdir(path.dirname(path.join(dir, key)));
    assert.deepEqual(entries, ["aaaa"]);
  });
});

test("LocalFilesystemStorage delete is idempotent; missing get throws", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    await assert.doesNotReject(() => storage.delete("org/o/doc/d/v1/missing"));
    await assert.rejects(
      () => storage.get("org/o/doc/d/v1/missing"),
      StorageObjectNotFoundError,
    );

    const key = "org/o/doc/d/v1/bbbb";
    await storage.put(key, randomBytes(16));
    assert.equal(await storage.exists(key), true);
    await storage.delete(key);
    assert.equal(await storage.exists(key), false);
    await storage.delete(key); // second delete: no throw
  });
});

test("LocalFilesystemStorage refuses to read or write outside its root", async () => {
  await withTmpDir(async (dir) => {
    const outsideRoot = path.join(dir, "root");
    await mkdir(outsideRoot, { recursive: true });
    const secret = path.join(dir, "secret.txt");
    await writeFile(secret, "top secret");

    const storage = new LocalFilesystemStorage(outsideRoot);
    for (const key of [
      "../secret.txt",
      "../../secret.txt",
      "a/../../secret.txt",
      "/etc/hosts",
      "..\\secret.txt",
    ]) {
      await assert.rejects(() => storage.get(key), /Unsafe storage key/);
      await assert.rejects(
        () => storage.put(key, Buffer.from("x")),
        /Unsafe storage key/,
      );
    }
    assert.equal(await readFile(secret, "utf8"), "top secret");
  });
});

// ------------------------------------------------------------
// LocalFilesystemStorage: streaming stage / promote / read
// ------------------------------------------------------------

test("stageStream measures size + SHA-256 while streaming, promote stores exact bytes", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const data = randomBytes(500_003);

    const staged = await storage.stageStream(Readable.from([data]), {
      maxBytes: 10 * 1024 * 1024,
    });
    assert.equal(staged.size, data.byteLength);
    assert.equal(staged.sha256, sha256Hex(data));

    const key = "org/o/doc/d/v1/cafebabe";
    await storage.promoteStaged(staged, key);
    await storage.discardStaged(staged);

    // Staged handle is gone; the final object holds the exact bytes.
    assert.deepEqual(await stagingEntries(dir), []);
    const { sha256, size } = await storage.hashObject(key);
    assert.equal(sha256, sha256Hex(data));
    assert.equal(size, data.byteLength);

    const { stream, size: streamSize } = await storage.openReadStream(key);
    assert.equal(streamSize, data.byteLength);
    assert.ok((await drain(stream)).equals(data));
  });
});

test("stageStream aborts an oversized transfer mid-stream and cleans partial staging", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    await assert.rejects(
      () => storage.stageStream(chunkedSource(2_000_000), { maxBytes: 200_000 }),
      UploadTooLargeError,
    );
    assert.deepEqual(
      await stagingEntries(dir),
      [],
      "partial staging file must be removed",
    );
  });
});

test("promoteStaged never overwrites an existing final key (immutable)", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const key = "org/o/doc/d/v1/deadbeef";

    const winner = await storage.stageStream(Readable.from([randomBytes(128)]), {
      maxBytes: 1 << 20,
    });
    const loser = await storage.stageStream(Readable.from([randomBytes(128)]), {
      maxBytes: 1 << 20,
    });

    await storage.promoteStaged(winner, key);
    await assert.rejects(
      () => storage.promoteStaged(loser, key),
      StorageObjectExistsError,
    );

    const { sha256 } = await storage.hashObject(key);
    assert.equal(sha256, winner.sha256, "original bytes are preserved");

    await storage.discardStaged(winner);
    await storage.discardStaged(loser);
  });
});

test("concurrent promoteStaged to the same key: exactly one wins, no overwrite", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const key = "org/o/doc/d/v1/00c0ffee";

    const staged = await Promise.all(
      Array.from({ length: 10 }, () =>
        storage.stageStream(Readable.from([randomBytes(64)]), {
          maxBytes: 1 << 20,
        }),
      ),
    );

    const results = await Promise.allSettled(
      staged.map((s) => storage.promoteStaged(s, key)),
    );

    const winners = results.filter((r) => r.status === "fulfilled");
    assert.equal(winners.length, 1, "exactly one promotion succeeds");
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(
          r.reason instanceof StorageObjectExistsError,
          `unexpected rejection: ${r.reason}`,
        );
      }
    }

    // The stored object matches exactly one of the staged inputs and nothing
    // partially-written.
    const { sha256 } = await storage.hashObject(key);
    assert.ok(staged.some((s) => s.sha256 === sha256));
  });
});

test("openReadStream / hashObject reject a missing object", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    await assert.rejects(
      () => storage.openReadStream("org/o/doc/d/v1/nope"),
      StorageObjectNotFoundError,
    );
    await assert.rejects(
      () => storage.hashObject("org/o/doc/d/v1/nope"),
      StorageObjectNotFoundError,
    );
  });
});

// ------------------------------------------------------------
// Upload orchestration (DI): streaming, version increment, failure cleanup
// ------------------------------------------------------------

class InMemoryProvider implements StorageProvider {
  readonly objects = new Map<string, Buffer>();
  readonly staged = new Map<string, Buffer>();
  promoteCalls: string[] = [];
  deleteCalls: string[] = [];
  discardCalls: string[] = [];
  failNextStage: Error | null = null;

  async put(key: string, data: Buffer): Promise<void> {
    if (this.objects.has(key)) throw new StorageObjectExistsError(key);
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const v = this.objects.get(key);
    if (!v) throw new StorageObjectNotFoundError(key);
    return Buffer.from(v);
  }
  async stageStream(
    source: Readable,
    opts: { maxBytes: number },
  ): Promise<StagedUpload> {
    if (this.failNextStage) {
      const err = this.failNextStage;
      this.failNextStage = null;
      source.destroy?.();
      throw err;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source) {
      const buf = Buffer.from(chunk as Buffer);
      size += buf.byteLength;
      if (size > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes);
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks);
    const ref = `staged-${randomBytes(8).toString("hex")}`;
    this.staged.set(ref, data);
    return { provider: "memory", ref, size, sha256: sha256Hex(data) };
  }
  async promoteStaged(staged: StagedUpload, finalKey: string): Promise<void> {
    this.promoteCalls.push(finalKey);
    const data = this.staged.get(staged.ref);
    if (!data) throw new Error(`unknown staged ref ${staged.ref}`);
    if (this.objects.has(finalKey)) throw new StorageObjectExistsError(finalKey);
    this.objects.set(finalKey, Buffer.from(data));
  }
  async discardStaged(staged: StagedUpload): Promise<void> {
    this.discardCalls.push(staged.ref);
    this.staged.delete(staged.ref);
  }
  async openReadStream(
    key: string,
  ): Promise<{ stream: Readable; size: number }> {
    const v = this.objects.get(key);
    if (!v) throw new StorageObjectNotFoundError(key);
    return { stream: Readable.from([Buffer.from(v)]), size: v.byteLength };
  }
  async hashObject(key: string): Promise<{ sha256: string; size: number }> {
    const v = this.objects.get(key);
    if (!v) throw new StorageObjectNotFoundError(key);
    return { sha256: sha256Hex(v), size: v.byteLength };
  }
  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

class VersionConflict extends Error {}

function makeDeps(
  provider: StorageProvider,
  overrides: Partial<UploadDeps> & {
    versions?: number[];
    persist?: UploadDeps["persistFileVersionRow"];
  } = {},
): { deps: UploadDeps; persisted: Array<Record<string, unknown>> } {
  const versions = overrides.versions ?? [1, 2, 3, 4, 5, 6];
  let i = 0;
  const persisted: Array<Record<string, unknown>> = [];
  const deps: UploadDeps = {
    provider,
    isVersionNumberConflict:
      overrides.isVersionNumberConflict ??
      ((e) => e instanceof VersionConflict),
    allocateNextVersionNumber:
      overrides.allocateNextVersionNumber ??
      (async () => versions[Math.min(i++, versions.length - 1)]),
    persistFileVersionRow:
      overrides.persist ??
      overrides.persistFileVersionRow ??
      (async (row) => {
        persisted.push({ ...row });
        return { id: `fv-${row.versionNumber}`, versionNumber: row.versionNumber };
      }),
  };
  return { deps, persisted };
}

function uploadInput(source: Readable, maxBytes = 50 * 1024 * 1024) {
  return {
    organizationId: "orgA",
    cadDocumentId: "docA",
    actorUserId: "userA",
    source,
    maxBytes,
    originalFileName: "../evil/Part.IPT",
  };
}

test("uploadCadFileVersion: streams end-to-end, computes checksum + size server-side", async () => {
  const provider = new InMemoryProvider();
  const { deps, persisted } = makeDeps(provider);
  const bytes = randomBytes(5000);

  const result = await uploadCadFileVersion(
    uploadInput(Readable.from([bytes])),
    deps,
  );

  assert.equal(result.versionNumber, 1);
  assert.equal(result.fileSize, 5000);
  assert.equal(result.checksum, sha256Hex(bytes));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].fileSize, 5000);
  assert.equal(persisted[0].checksum, sha256Hex(bytes));
  assert.equal(persisted[0].originalFileName, "Part.IPT"); // path stripped
  assert.equal(persisted[0].storageKey, result.storageKey);
  assert.equal(persisted[0].createdById, "userA");
  assert.ok(String(result.storageKey).startsWith("org/orgA/doc/docA/v1/"));
  assert.equal(provider.objects.size, 1);
  assert.equal(provider.staged.size, 0, "staging is discarded on success");
  assert.equal(provider.discardCalls.length, 1);
  assert.ok((await provider.get(result.storageKey)).equals(bytes));
});

test("uploadCadFileVersion: end-to-end against the real local provider", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const { deps, persisted } = makeDeps(storage);
    const data = randomBytes(300_000);

    const result = await uploadCadFileVersion(
      uploadInput(Readable.from([data]), 1 << 20),
      deps,
    );

    assert.equal(result.fileSize, data.byteLength);
    assert.equal(result.checksum, sha256Hex(data));
    const { sha256 } = await storage.hashObject(result.storageKey);
    assert.equal(sha256, sha256Hex(data));
    assert.equal(persisted.length, 1);
    assert.deepEqual(await stagingEntries(dir), [], "staging is cleaned up");
  });
});

test("uploadCadFileVersion: oversized stream is rejected and nothing is persisted", async () => {
  await withTmpDir(async (dir) => {
    const storage = new LocalFilesystemStorage(dir);
    const { deps, persisted } = makeDeps(storage);

    await assert.rejects(
      () =>
        uploadCadFileVersion(uploadInput(chunkedSource(2_000_000), 250_000), deps),
      UploadTooLargeError,
    );

    assert.equal(persisted.length, 0);
    assert.deepEqual(await stagingEntries(dir), []);
    // No final objects were created.
    const rootEntries = await readdir(dir).catch(() => [] as string[]);
    assert.ok(!rootEntries.includes("org"));
  });
});

test("uploadCadFileVersion: empty stream is rejected", async () => {
  const provider = new InMemoryProvider();
  const { deps, persisted } = makeDeps(provider);

  await assert.rejects(
    () => uploadCadFileVersion(uploadInput(Readable.from([])), deps),
    EmptyUploadError,
  );
  assert.equal(persisted.length, 0);
  assert.equal(provider.objects.size, 0);
  assert.equal(provider.discardCalls.length, 1, "staging is still discarded");
});

test("uploadCadFileVersion: DB failure removes the orphaned object", async () => {
  const provider = new InMemoryProvider();
  const { deps } = makeDeps(provider, {
    persist: async () => {
      throw new Error("db exploded");
    },
  });

  await assert.rejects(
    () => uploadCadFileVersion(uploadInput(Readable.from([randomBytes(100)])), deps),
    /db exploded/,
  );

  assert.equal(provider.objects.size, 0, "orphaned bytes must be cleaned up");
  assert.equal(provider.deleteCalls.length, 1);
  assert.equal(provider.discardCalls.length, 1);
});

test("uploadCadFileVersion: version-number conflict retries and cleans losers", async () => {
  const provider = new InMemoryProvider();
  let attempts = 0;
  const { deps } = makeDeps(provider, {
    versions: [1, 2],
    persist: async (row) => {
      attempts += 1;
      if (attempts === 1) throw new VersionConflict("dup v1");
      return { id: "fv-2", versionNumber: row.versionNumber };
    },
  });

  const result = await uploadCadFileVersion(
    uploadInput(Readable.from([randomBytes(64)])),
    deps,
  );

  assert.equal(result.versionNumber, 2);
  assert.equal(provider.promoteCalls.length, 2);
  assert.equal(provider.deleteCalls.length, 1, "the losing v1 key is cleaned");
  assert.equal(provider.objects.size, 1);
  assert.equal(provider.staged.size, 0);
  assert.ok(String(result.storageKey).startsWith("org/orgA/doc/docA/v2/"));
});

test("uploadCadFileVersion: staging failure persists nothing", async () => {
  const provider = new InMemoryProvider();
  provider.failNextStage = new Error("disk full");
  let persistCalled = false;
  const { deps } = makeDeps(provider, {
    persist: async () => {
      persistCalled = true;
      return { id: "fv-1", versionNumber: 1 };
    },
  });

  await assert.rejects(
    () => uploadCadFileVersion(uploadInput(Readable.from([randomBytes(64)])), deps),
    /disk full/,
  );

  assert.equal(persistCalled, false);
  assert.equal(provider.objects.size, 0);
  assert.equal(provider.promoteCalls.length, 0);
});

test("uploadCadFileVersion: retry exhaustion throws and leaves no objects", async () => {
  const provider = new InMemoryProvider();
  const { deps } = makeDeps(provider, {
    versions: [1, 2, 3, 4, 5],
    persist: async () => {
      throw new VersionConflict("always dup");
    },
  });

  await assert.rejects(
    () => uploadCadFileVersion(uploadInput(Readable.from([randomBytes(64)])), deps),
    /Could not allocate a file version number/,
  );

  assert.equal(provider.promoteCalls.length, MAX_UPLOAD_ATTEMPTS);
  assert.equal(provider.deleteCalls.length, MAX_UPLOAD_ATTEMPTS);
  assert.equal(provider.objects.size, 0);
  assert.equal(provider.staged.size, 0);
});

// ------------------------------------------------------------
// WP-2A (2A-2): download integrity verdict - fail closed (PD-2A-3)
// ------------------------------------------------------------

test("verifyStoredChecksum: equal -> verified; different -> mismatch; missing/blank -> unverifiable (never served)", async () => {
  const { verifyStoredChecksum } = await import("../app/lib/storage-core.ts");
  const sha = "a".repeat(64);
  assert.equal(verifyStoredChecksum(sha, sha), "verified");
  assert.equal(verifyStoredChecksum("b".repeat(64), sha), "mismatch");
  for (const recorded of [null, undefined, "", "   "]) {
    assert.equal(verifyStoredChecksum(recorded, sha), "unverifiable", `recorded=${JSON.stringify(recorded)}`);
  }
});
