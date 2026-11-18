import "server-only";

import type { Readable } from "node:stream";

import { prisma } from "@/app/lib/prisma";
import type { Actor } from "@/app/lib/authz";
import {
  LocalFilesystemStorage,
  resolveMaxUploadBytes,
  resolveStorageRoot,
  verifyStoredChecksum,
  type StorageProvider,
  type UploadedFileVersion,
} from "@/app/lib/storage-core";
import {
  storeCadFileVersionForActor,
  ActiveCheckoutBlocksUploadError,
  CadDocumentNotFoundError,
  ReservedCopyDesignTargetError,
  UploadConcurrencyConflictError,
  type UploadGuardDb,
} from "@/app/lib/upload-guard-db";

/**
 * Server-only wiring for the PDM storage foundation: it binds the
 * provider-agnostic core (`app/lib/storage-core.ts`) to the database and to
 * the authenticated actor / tenant.
 *
 * Nothing here is reachable from client code (`server-only`).
 */

// ------------------------------------------------------------
// Provider factory
// ------------------------------------------------------------

let cachedProvider: StorageProvider | undefined;

/** The active storage provider. Local filesystem in dev; swap this one line
 *  for an S3-compatible provider later without touching the PDM model. */
export function getStorageProvider(): StorageProvider {
  if (!cachedProvider) {
    cachedProvider = new LocalFilesystemStorage(resolveStorageRoot());
  }
  return cachedProvider;
}

// ------------------------------------------------------------
// Domain errors (mapped to HTTP status in the route handlers)
// ------------------------------------------------------------

export {
  ActiveCheckoutBlocksUploadError,
  CadDocumentNotFoundError,
  ReservedCopyDesignTargetError,
  UploadConcurrencyConflictError,
};

export class FileVersionNotFoundError extends Error {
  constructor() {
    super("File version not found in your organization");
    this.name = "FileVersionNotFoundError";
  }
}

export class StoredFileMissingError extends Error {
  constructor() {
    super("No stored file exists for this file version");
    this.name = "StoredFileMissingError";
  }
}

export class StoredFileCorruptError extends Error {
  constructor() {
    super("Stored file failed its integrity check");
    this.name = "StoredFileCorruptError";
  }
}

/** WP-2A (2A-2, PD-2A-3): no checksum is recorded, so the file cannot be
 *  verified and is not served (fail closed). */
export class StoredFileUnverifiedError extends Error {
  constructor() {
    super("This file version has no recorded checksum, so its integrity cannot be verified; it is not served");
    this.name = "StoredFileUnverifiedError";
  }
}

// ------------------------------------------------------------
// Upload
// ------------------------------------------------------------

/**
 * Store an uploaded CAD binary and create the next immutable FileVersion for
 * `cadDocumentId`.
 *
 * Security:
 *   - the CAD document must belong to `actor.organizationId`;
 *   - organizationId, createdById, storageKey, checksum and fileSize are all
 *     server-derived (from `actor` and from the bytes) - never from the client;
 *   - the storage key is server-generated from stable internal IDs.
 *
 * Invariant: this NEVER creates or mutates an ItemRevision or lifecycle state -
 * it only reads CadDocument and writes a FileVersion row.
 *
 * Thin wrapper: all logic (including the P3C-2 exclusive-checkout guard and
 * its shared CadDocument-row-lock concurrency design) lives in the plain,
 * non-`server-only` `app/lib/upload-guard-db.ts`, which is what the focused
 * tests exercise directly with an in-memory fake database.
 */
export async function storeCadFileVersion(
  actor: Actor,
  cadDocumentId: string,
  source: Readable,
  originalFileName: string | null | undefined,
  db: UploadGuardDb = prisma,
  provider: StorageProvider = getStorageProvider(),
  maxBytes: number = resolveMaxUploadBytes(),
): Promise<UploadedFileVersion> {
  return storeCadFileVersionForActor(
    actor,
    cadDocumentId,
    source,
    originalFileName,
    maxBytes,
    db,
    provider,
  );
}

// ------------------------------------------------------------
// Download
// ------------------------------------------------------------

export interface DownloadedFileVersion {
  /** A fresh Node stream of the stored bytes. The caller pipes it to the
   *  HTTP response - the whole file is never held in memory. */
  stream: Readable;
  originalFileName: string;
  fileSize: number;
  checksum: string;
  versionNumber: number;
  cadDocumentId: string;
}

/**
 * Open the exact bytes of one FileVersion for streaming, authorized for
 * `actor`'s tenant.
 *
 * The FileVersion is looked up with `organizationId = actor.organizationId`, so
 * a caller can never reach another organization's version.
 *
 * Integrity: the stored object is streamed through SHA-256 FIRST (a hashing
 * pass that never buffers the whole file) and compared to the recorded
 * checksum. Only if it matches is a second, fresh read stream opened and
 * returned - a known-corrupt object is reported (StoredFileCorruptError), never
 * served as valid.
 */
export async function readCadFileVersionForActor(
  actor: Actor,
  fileVersionId: string,
): Promise<DownloadedFileVersion> {
  const fileVersion = await prisma.fileVersion.findFirst({
    where: { id: fileVersionId, organizationId: actor.organizationId },
    select: {
      id: true,
      versionNumber: true,
      originalFileName: true,
      storageKey: true,
      checksum: true,
      cadDocumentId: true,
    },
  });

  if (!fileVersion) {
    throw new FileVersionNotFoundError();
  }

  const provider = getStorageProvider();

  let verified: { sha256: string; size: number };
  try {
    verified = await provider.hashObject(fileVersion.storageKey);
  } catch {
    // Includes the metadata-only FileVersions created before this milestone,
    // whose synthetic storageKey has no bytes behind it.
    throw new StoredFileMissingError();
  }

  // WP-2A (2A-2): fail closed - serve only bytes that match a recorded checksum.
  const verdict = verifyStoredChecksum(fileVersion.checksum, verified.sha256);
  if (verdict === "unverifiable") {
    throw new StoredFileUnverifiedError();
  }
  if (verdict === "mismatch") {
    throw new StoredFileCorruptError();
  }

  const { stream } = await provider.openReadStream(fileVersion.storageKey);

  return {
    stream,
    originalFileName: fileVersion.originalFileName,
    fileSize: verified.size,
    checksum: verified.sha256,
    versionNumber: fileVersion.versionNumber,
    cadDocumentId: fileVersion.cadDocumentId,
  };
}
