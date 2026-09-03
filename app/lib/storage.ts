import "server-only";

import type { Readable } from "node:stream";

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/app/lib/prisma";
import type { Actor } from "@/app/lib/authz";
import {
  LocalFilesystemStorage,
  resolveMaxUploadBytes,
  resolveStorageRoot,
  uploadCadFileVersion,
  type StorageProvider,
  type UploadedFileVersion,
} from "@/app/lib/storage-core";

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

export class CadDocumentNotFoundError extends Error {
  constructor() {
    super("CAD document not found in your organization");
    this.name = "CadDocumentNotFoundError";
  }
}

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

function isVersionNumberConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
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
 * The filesystem/object store does NOT participate in the DB transaction;
 * `uploadCadFileVersion` handles storage-success/DB-failure cleanup.
 */
export async function storeCadFileVersion(
  actor: Actor,
  cadDocumentId: string,
  source: Readable,
  originalFileName: string | null | undefined,
): Promise<UploadedFileVersion> {
  const cadDocument = await prisma.cadDocument.findFirst({
    where: { id: cadDocumentId, organizationId: actor.organizationId },
    select: { id: true, fileName: true },
  });

  if (!cadDocument) {
    throw new CadDocumentNotFoundError();
  }

  const provider = getStorageProvider();

  return uploadCadFileVersion(
    {
      organizationId: actor.organizationId,
      cadDocumentId: cadDocument.id,
      actorUserId: actor.userId,
      source,
      maxBytes: resolveMaxUploadBytes(),
      originalFileName: originalFileName ?? cadDocument.fileName,
    },
    {
      provider,
      isVersionNumberConflict,
      async allocateNextVersionNumber() {
        // Reuse the existing version-number concurrency model: MAX+1, with the
        // @@unique([cadDocumentId, versionNumber]) constraint as the source of
        // truth (a losing race retries).
        const latest = await prisma.fileVersion.findFirst({
          where: {
            cadDocumentId: cadDocument.id,
            organizationId: actor.organizationId,
          },
          orderBy: { versionNumber: "desc" },
          select: { versionNumber: true },
        });
        return (latest?.versionNumber ?? 0) + 1;
      },
      async persistFileVersionRow(row) {
        const created = await prisma.fileVersion.create({
          data: {
            organizationId: row.organizationId,
            cadDocumentId: row.cadDocumentId,
            createdById: row.createdById,
            versionNumber: row.versionNumber,
            originalFileName: row.originalFileName,
            storageKey: row.storageKey,
            fileSize: BigInt(row.fileSize),
            checksum: row.checksum,
          },
          select: { id: true, versionNumber: true },
        });
        return created;
      },
    },
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

  if (fileVersion.checksum && fileVersion.checksum !== verified.sha256) {
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
