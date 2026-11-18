/**
 * Arch PDM - storage foundation (provider-agnostic core).
 *
 * This module is intentionally free of framework, database and `@/` imports:
 * only Node built-ins. It holds the storage-provider abstraction, the local
 * filesystem implementation, server-generated key rules, and the upload
 * orchestration (with dependency injection so failure/cleanup paths are
 * testable). The database + request-auth wiring lives in `app/lib/storage.ts`.
 *
 * An S3-compatible provider can be added later by implementing StorageProvider
 * and swapping the factory in `app/lib/storage.ts` - no PDM domain-model change.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

// Control characters: NUL..US (0x00-0x1F) plus DEL (0x7F).
const CONTROL_CHAR_CLASS = "[\u0000-\u001F\u007F]";
const HAS_CONTROL_CHAR = new RegExp(CONTROL_CHAR_CLASS);
const ALL_CONTROL_CHARS = new RegExp(CONTROL_CHAR_CLASS, "g");

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class UnsafeStorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Unsafe storage key (${reason}): ${JSON.stringify(key)}`);
    this.name = "UnsafeStorageKeyError";
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Stored object not found: ${JSON.stringify(key)}`);
    this.name = "StorageObjectNotFoundError";
  }
}

export class StorageObjectExistsError extends Error {
  constructor(key: string) {
    super(`Stored object already exists (immutable): ${JSON.stringify(key)}`);
    this.name = "StorageObjectExistsError";
  }
}

export class UploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Upload exceeds the maximum allowed size of ${maxBytes} bytes`);
    this.name = "UploadTooLargeError";
  }
}

export class EmptyUploadError extends Error {
  constructor() {
    super("Upload contained no bytes");
    this.name = "EmptyUploadError";
  }
}

// ------------------------------------------------------------
// Download integrity verdict (WP-2A, item 2A-2)
// ------------------------------------------------------------

/**
 * Outcome of comparing a FileVersion's RECORDED checksum with the SHA-256
 * actually computed from the stored bytes:
 *  - "verified": both present and equal - the bytes may be served;
 *  - "mismatch": the stored bytes differ from the record (corrupt / replaced);
 *  - "unverifiable": no checksum is recorded, so integrity cannot be proven.
 *
 * Product Owner decision PD-2A-3 (2026-11-18): an "unverifiable" version is
 * REFUSED (fail closed) - an engineering file is never served unverified.
 * Every current upload path (direct upload, check-in, Copy Design
 * materialize) records a checksum; only legacy rows can be affected.
 */
export type StoredChecksumVerdict = "verified" | "mismatch" | "unverifiable";

export function verifyStoredChecksum(
  recordedChecksum: string | null | undefined,
  computedSha256: string,
): StoredChecksumVerdict {
  if (typeof recordedChecksum !== "string" || recordedChecksum.trim() === "") {
    return "unverifiable";
  }
  return recordedChecksum === computedSha256 ? "verified" : "mismatch";
}

// ------------------------------------------------------------
// Provider abstraction
// ------------------------------------------------------------

/**
 * A provider-opaque handle to bytes that have been fully received and hashed
 * but not yet placed at any final (immutable) key. The size and SHA-256 are
 * computed by the provider while streaming - never supplied by the client.
 */
export interface StagedUpload {
  /** Which provider produced this handle (guards against cross-provider use). */
  readonly provider: string;
  /** Provider-internal reference (e.g. a staging path). Never sent to a client. */
  readonly ref: string;
  /** Server-measured byte length. */
  readonly size: number;
  /** Server-computed lowercase hex SHA-256. */
  readonly sha256: string;
}

export interface StorageProvider {
  /** Write `data` at `key`. Rejects with StorageObjectExistsError if `key`
   *  already exists - stored objects are immutable. */
  put(key: string, data: Buffer): Promise<void>;
  /** Read the bytes at `key`. Rejects with StorageObjectNotFoundError if
   *  missing. */
  get(key: string): Promise<Buffer>;
  /**
   * Stream `source` into temporary staging, enforcing `maxBytes` WHILE reading
   * (the transfer is aborted and partial staging removed the moment the limit
   * is passed - Content-Length is never trusted). The staged bytes are not yet
   * at any final key; promote or discard them afterwards.
   */
  stageStream(
    source: Readable,
    opts: { maxBytes: number },
  ): Promise<StagedUpload>;
  /** Atomically place staged bytes at `finalKey`. Never overwrites an existing
   *  object (no exists()->rename() window): rejects with
   *  StorageObjectExistsError if `finalKey` is already taken. */
  promoteStaged(staged: StagedUpload, finalKey: string): Promise<void>;
  /** Best-effort removal of staged bytes that were never promoted. */
  discardStaged(staged: StagedUpload): Promise<void>;
  /** Open a streaming read for `key` (no full-file buffering) plus its size.
   *  Rejects with StorageObjectNotFoundError if missing. */
  openReadStream(key: string): Promise<{ stream: Readable; size: number }>;
  /** Stream `key` through SHA-256 without buffering it whole; returns the
   *  lowercase hex digest and the byte size. */
  hashObject(key: string): Promise<{ sha256: string; size: number }>;
  /** Best-effort delete used for cleanup. Resolves quietly if `key` is
   *  already gone. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// ------------------------------------------------------------
// Key rules - every key is SERVER-GENERATED. Client input never
// reaches a key. These checks are defence-in-depth for the abstraction.
// ------------------------------------------------------------

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `key` is a safe, relative, forward-slash POSIX-style path
 *  with no traversal, no absolute prefix, no `.`/`..` segments, no control
 *  characters and no backslashes. */
export function assertSafeRelativeKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new UnsafeStorageKeyError(String(key), "empty");
  }
  if (key.length > 1024) {
    throw new UnsafeStorageKeyError(key, "too long");
  }
  if (key.includes("\\")) {
    throw new UnsafeStorageKeyError(key, "backslash");
  }
  if (HAS_CONTROL_CHAR.test(key)) {
    throw new UnsafeStorageKeyError(key, "control character");
  }
  if (key.startsWith("/") || key.startsWith("~")) {
    throw new UnsafeStorageKeyError(key, "absolute / home");
  }
  // A Windows drive prefix such as "C:" must never appear.
  if (/^[A-Za-z]:/.test(key)) {
    throw new UnsafeStorageKeyError(key, "drive prefix");
  }
  for (const segment of key.split("/")) {
    if (segment.length === 0) {
      throw new UnsafeStorageKeyError(key, "empty segment");
    }
    if (segment === "." || segment === "..") {
      throw new UnsafeStorageKeyError(key, "dot segment");
    }
    if (!SAFE_KEY_SEGMENT.test(segment)) {
      throw new UnsafeStorageKeyError(
        key,
        `bad segment ${JSON.stringify(segment)}`,
      );
    }
  }
}

/** A fresh per-upload-attempt nonce so every write targets a unique key -
 *  a losing version-race attempt can be cleaned up without touching any
 *  other attempt's bytes. */
export function newUploadNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The canonical storage key for a CAD file version. Built ONLY from stable
 * internal identifiers and server-side values - never from client-supplied
 * organizationId, storageKey, path, filename, checksum or size.
 *
 *   org/<organizationId>/doc/<cadDocumentId>/v<versionNumber>/<uploadNonce>
 */
export function fileVersionStorageKey(input: {
  organizationId: string;
  cadDocumentId: string;
  versionNumber: number;
  uploadNonce: string;
}): string {
  if (!Number.isInteger(input.versionNumber) || input.versionNumber < 1) {
    throw new Error(`Invalid versionNumber: ${input.versionNumber}`);
  }
  const key = [
    "org",
    input.organizationId,
    "doc",
    input.cadDocumentId,
    `v${input.versionNumber}`,
    input.uploadNonce,
  ].join("/");
  assertSafeRelativeKey(key);
  return key;
}

// ------------------------------------------------------------
// Hashing
// ------------------------------------------------------------

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ------------------------------------------------------------
// Original filename handling (display only - never used in a key)
// ------------------------------------------------------------

export function normalizeOriginalFileName(
  raw: string | null | undefined,
): string {
  if (typeof raw !== "string") {
    return "upload.bin";
  }
  // Keep the last path segment only, then strip control chars / leading dots.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(ALL_CONTROL_CHARS, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : "upload.bin";
}

// ------------------------------------------------------------
// Storage root resolution (configurable, git-ignored)
// ------------------------------------------------------------

export const DEFAULT_STORAGE_DIRNAME = ".pdm-storage";

/** Absolute path of the local storage root. Configurable via PDM_STORAGE_ROOT;
 *  defaults to `<cwd>/.pdm-storage` (git-ignored). */
export function resolveStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.PDM_STORAGE_ROOT?.trim();
  if (configured && configured.length > 0) {
    return path.resolve(cwd, configured);
  }
  return path.resolve(cwd, DEFAULT_STORAGE_DIRNAME);
}

/** Coarse safety cap on a single upload. CAD assemblies are large but not
 *  unlimited; this is enforced while streaming, not from Content-Length.
 *  Configurable via PDM_MAX_UPLOAD_BYTES (positive integer). */
export const DEFAULT_MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export function resolveMaxUploadBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.PDM_MAX_UPLOAD_BYTES);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MAX_UPLOAD_BYTES;
}

// ------------------------------------------------------------
// Local filesystem provider
// ------------------------------------------------------------

export class LocalFilesystemStorage implements StorageProvider {
  readonly #root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error(`Storage root must be an absolute path: ${root}`);
    }
    this.#root = path.resolve(root);
  }

  #resolve(key: string): string {
    assertSafeRelativeKey(key);
    const full = path.resolve(this.#root, key);
    const withSep = this.#root.endsWith(path.sep)
      ? this.#root
      : this.#root + path.sep;
    if (full !== this.#root && !full.startsWith(withSep)) {
      throw new UnsafeStorageKeyError(key, "escapes storage root");
    }
    return full;
  }

  /** Absolute path of the staging area for in-progress uploads. It lives
   *  under the root (so promotion is a same-filesystem hard link) but is not
   *  itself a valid key namespace. */
  get #stagingDir(): string {
    return path.join(this.#root, ".staging");
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.#resolve(key);
    await mkdir(path.dirname(target), { recursive: true });

    const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Exclusive create for the temp file, then durable write, then an
      // atomic hard link that fails (EEXIST) if the final key already exists -
      // there is no exists()->rename() window in which a racing writer could
      // clobber an immutable object.
      handle = await open(tmp, "wx");
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await this.#linkExclusive(tmp, target, key);
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
      // The temp inode is now also linked at `target` (on success) or orphaned
      // (on failure); unlinking this name is always correct.
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Hard-link `source` to `target`, translating EEXIST into the immutable-
   *  object error. This is the single choke point for "create a final object". */
  async #linkExclusive(
    source: string,
    target: string,
    key: string,
  ): Promise<void> {
    try {
      await link(source, target);
    } catch (error) {
      if (isEexist(error)) {
        throw new StorageObjectExistsError(key);
      }
      throw error;
    }
  }

  async stageStream(
    source: Readable,
    opts: { maxBytes: number },
  ): Promise<StagedUpload> {
    await mkdir(this.#stagingDir, { recursive: true });
    const ref = path.join(
      this.#stagingDir,
      `${randomBytes(16).toString("hex")}.part`,
    );

    const handle = await open(ref, "wx");
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        size += buf.byteLength;
        if (size > opts.maxBytes) {
          throw new UploadTooLargeError(opts.maxBytes);
        }
        hash.update(buf);
        await handle.write(buf);
      }
      await handle.sync();
      await handle.close();
      return {
        provider: "local",
        ref,
        size,
        sha256: hash.digest("hex"),
      };
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(ref, { force: true }).catch(() => {});
      // Free the connection instead of draining a rejected upload.
      source.destroy?.();
      throw error;
    }
  }

  async promoteStaged(staged: StagedUpload, finalKey: string): Promise<void> {
    this.#assertOwnStaged(staged);
    const target = this.#resolve(finalKey);
    await mkdir(path.dirname(target), { recursive: true });
    await this.#linkExclusive(staged.ref, target, finalKey);
  }

  async discardStaged(staged: StagedUpload): Promise<void> {
    this.#assertOwnStaged(staged);
    await rm(staged.ref, { force: true });
  }

  #assertOwnStaged(staged: StagedUpload): void {
    if (staged.provider !== "local") {
      throw new Error(
        `Staged upload belongs to provider ${JSON.stringify(staged.provider)}, not "local"`,
      );
    }
    const resolved = path.resolve(staged.ref);
    const dir = this.#stagingDir.endsWith(path.sep)
      ? this.#stagingDir
      : this.#stagingDir + path.sep;
    if (!resolved.startsWith(dir)) {
      throw new Error("Staged upload reference escapes the staging directory");
    }
  }

  async openReadStream(
    key: string,
  ): Promise<{ stream: Readable; size: number }> {
    const target = this.#resolve(key);
    let size: number;
    try {
      size = (await stat(target)).size;
    } catch (error) {
      if (isEnoent(error)) {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
    return { stream: createReadStream(target), size };
  }

  async hashObject(key: string): Promise<{ sha256: string; size: number }> {
    const { stream, size } = await this.openReadStream(key);
    const hash = createHash("sha256");
    try {
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
    } catch (error) {
      stream.destroy?.();
      throw error;
    }
    return { sha256: hash.digest("hex"), size };
  }

  async get(key: string): Promise<Buffer> {
    const target = this.#resolve(key);
    try {
      return await readFile(target);
    } catch (error) {
      if (isEnoent(error)) {
        throw new StorageObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    let target: string;
    try {
      target = this.#resolve(key);
    } catch {
      // An unsafe key can never have been written by us - nothing to delete.
      return;
    }
    await rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const target = this.#resolve(key);
    try {
      await access(target, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function isEnoent(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}

function isEexist(error: unknown): boolean {
  return isErrnoCode(error, "EEXIST");
}

// ------------------------------------------------------------
// Upload orchestration (dependency-injected; DB + fs are NOT one transaction)
// ------------------------------------------------------------

export const MAX_UPLOAD_ATTEMPTS = 5;

const VERSION_ALLOCATION_EXHAUSTED =
  "Could not allocate a file version number after multiple attempts, please retry";

export interface PersistFileVersionInput {
  organizationId: string;
  cadDocumentId: string;
  createdById: string;
  versionNumber: number;
  originalFileName: string;
  storageKey: string;
  fileSize: number;
  checksum: string;
}

export interface UploadDeps {
  provider: StorageProvider;
  /** MAX(versionNumber)+1 for this (organization, cadDocument). */
  allocateNextVersionNumber(): Promise<number>;
  /** Insert the immutable FileVersion row. MUST NOT touch ItemRevision or
   *  lifecycle state. */
  persistFileVersionRow(
    input: PersistFileVersionInput,
  ): Promise<{ id: string; versionNumber: number }>;
  /** True when the persist failure is a version-number uniqueness conflict
   *  (safe to retry with a higher number). */
  isVersionNumberConflict(error: unknown): boolean;
}

export interface UploadedFileVersion {
  fileVersionId: string;
  versionNumber: number;
  storageKey: string;
  checksum: string;
  fileSize: number;
}

/**
 * Stream an uploaded CAD binary into storage and create the next immutable
 * FileVersion.
 *
 * SHA-256 and byte size are computed here, server-side, from the streamed
 * bytes - never taken from the caller/client. `maxBytes` is enforced WHILE
 * reading `source` (Content-Length is never trusted); when the limit is
 * passed the transfer is aborted and the partial staging file removed.
 *
 * Ordering & cleanup (filesystem/object storage is NOT part of the DB
 * transaction):
 *   1. stream `source` ONCE into provider staging - hash + size measured here,
 *      oversized transfers aborted + partial staging cleaned
 *   2. allocate the next version number
 *   3. promote (atomically, no-overwrite) the staged bytes to a unique
 *      per-attempt final key
 *   4. insert the FileVersion row
 *      - on version-number conflict: delete the promoted key, retry (2)
 *      - on any other DB failure: delete the promoted key, rethrow
 *   5. the staging handle is always discarded at the end (success or failure)
 *   6. on a staging failure: nothing was persisted, nothing to clean
 */
export async function uploadCadFileVersion(
  input: {
    organizationId: string;
    cadDocumentId: string;
    actorUserId: string;
    source: Readable;
    maxBytes: number;
    originalFileName: string | null | undefined;
  },
  deps: UploadDeps,
): Promise<UploadedFileVersion> {
  const originalFileName = normalizeOriginalFileName(input.originalFileName);

  // Consume the request stream exactly once. Retries re-promote the same
  // staged bytes under a new key - the stream is never re-read.
  const staged = await deps.provider.stageStream(input.source, {
    maxBytes: input.maxBytes,
  });

  try {
    if (staged.size === 0) {
      throw new EmptyUploadError();
    }

    const fileSize = staged.size;
    const checksum = staged.sha256;

    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      const versionNumber = await deps.allocateNextVersionNumber();
      const storageKey = fileVersionStorageKey({
        organizationId: input.organizationId,
        cadDocumentId: input.cadDocumentId,
        versionNumber,
        uploadNonce: newUploadNonce(),
      });

      await deps.provider.promoteStaged(staged, storageKey);

      try {
        const row = await deps.persistFileVersionRow({
          organizationId: input.organizationId,
          cadDocumentId: input.cadDocumentId,
          createdById: input.actorUserId,
          versionNumber,
          originalFileName,
          storageKey,
          fileSize,
          checksum,
        });

        return {
          fileVersionId: row.id,
          versionNumber: row.versionNumber,
          storageKey,
          checksum,
          fileSize,
        };
      } catch (error) {
        // Promotion succeeded, DB failed -> remove the orphaned final object.
        await safeDelete(deps.provider, storageKey);

        if (deps.isVersionNumberConflict(error)) {
          if (attempt < MAX_UPLOAD_ATTEMPTS) {
            continue;
          }
          throw new Error(VERSION_ALLOCATION_EXHAUSTED);
        }
        throw error;
      }
    }

    throw new Error(VERSION_ALLOCATION_EXHAUSTED);
  } finally {
    // The staged inode is either already hard-linked at a final key (success)
    // or no longer wanted (failure); dropping the staging name is always safe.
    await deps.provider.discardStaged(staged).catch(() => {});
  }
}

async function safeDelete(
  provider: StorageProvider,
  key: string,
): Promise<void> {
  try {
    await provider.delete(key);
  } catch {
    // Best effort. A rare leftover object is inert (no DB row references it)
    // and is a candidate for a future storage GC sweep.
  }
}
