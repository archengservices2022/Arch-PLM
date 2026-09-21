/**
 * Arch PLM - P6C server bridge: materialize the FIRST FileVersion for a
 * CadDocument already RESERVED by P6B Copy Design (provider-agnostic core).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only request-shape
 * validation for the small set of metadata fields this endpoint needs beyond
 * the raw binary body (sent as headers, exactly like the existing check-in /
 * direct-upload endpoints send `X-Original-Filename`).
 *
 * SCOPE: this is NOT a general upload/version endpoint. It exists ONLY to let
 * CAD Connect (P6C), after physically creating + rewiring + verifying an
 * Inventor IAM/IPT file locally, attach that verified binary as FileVersion 1
 * of a CadDocument P6B already reserved (CadCopyLineage names it as the NEW
 * document; it has zero FileVersion rows). All Prisma-shaped eligibility /
 * concurrency / storage wiring lives in `copy-design-materialize-db.ts`.
 *
 * IDENTITY DISCIPLINE: `copyDesignOperationId` / `cadDocumentId` /
 * `sourceCadDocumentId` are STABLE DATABASE IDS - the ONLY identity this
 * module ever trusts. `originalFileName` is display metadata only.
 * `expectedSha256` / `expectedFileSize` are the CALLER's OWN claim about what
 * it is about to upload - used only to fail fast/clearly if the actual
 * uploaded bytes (hashed server-side, exactly like every other upload path)
 * do not match what the caller believed it was sending; they are NEVER
 * trusted as the recorded checksum/fileSize themselves.
 */
import { CAD_DOCUMENT_TYPES, type CadDocumentTypeValue } from "./copy-design-lineage-core.ts";

export const MAX_MATERIALIZE_FIELD_LENGTH = 200;

/** Mirrors `copy-design-lineage-core.ts`'s validation-error shape. */
export class CopyDesignMaterializeValidationError extends Error {
  readonly status = 400;
  readonly publicMessage: string;
  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "CopyDesignMaterializeValidationError";
    this.publicMessage = publicMessage;
  }
}

export interface CopyDesignMaterializeRequestMeta {
  copyDesignOperationId: string;
  cadDocumentId: string;
  sourceCadDocumentId: string;
  documentType: CadDocumentTypeValue;
  originalFileName: string | null;
  /** Lowercase hex SHA-256, exactly 64 characters. */
  expectedSha256: string;
  expectedFileSize: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function requiredHeader(value: string | null | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new CopyDesignMaterializeValidationError(`${field} header is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CopyDesignMaterializeValidationError(`${field} header must not be blank.`);
  }
  if (trimmed.length > MAX_MATERIALIZE_FIELD_LENGTH) {
    throw new CopyDesignMaterializeValidationError(`${field} header is too long.`);
  }
  return trimmed;
}

/**
 * Parse and validate the request's header metadata. `cadDocumentId` comes
 * from the route path (not a header) and is validated the same way by the
 * caller before this is invoked.
 *
 * @throws CopyDesignMaterializeValidationError (400) for any malformed field.
 */
export function parseMaterializeRequestHeaders(
  headers: {
    copyDesignOperationId: string | null;
    sourceCadDocumentId: string | null;
    documentType: string | null;
    originalFileName: string | null;
    expectedSha256: string | null;
    expectedFileSize: string | null;
  },
  cadDocumentId: string,
): CopyDesignMaterializeRequestMeta {
  const copyDesignOperationId = requiredHeader(headers.copyDesignOperationId, "X-Copy-Design-Operation-Id");
  const sourceCadDocumentId = requiredHeader(headers.sourceCadDocumentId, "X-Source-Cad-Document-Id");

  const documentTypeRaw = requiredHeader(headers.documentType, "X-Document-Type").toUpperCase();
  if (!(CAD_DOCUMENT_TYPES as readonly string[]).includes(documentTypeRaw)) {
    throw new CopyDesignMaterializeValidationError(
      `X-Document-Type header must be one of ${CAD_DOCUMENT_TYPES.join(", ")}.`,
    );
  }

  const expectedSha256 = requiredHeader(headers.expectedSha256, "X-Expected-Sha256").toLowerCase();
  if (!SHA256_HEX.test(expectedSha256)) {
    throw new CopyDesignMaterializeValidationError("X-Expected-Sha256 header must be exactly 64 lowercase hex characters.");
  }

  const expectedFileSizeRaw = requiredHeader(headers.expectedFileSize, "X-Expected-File-Size");
  const expectedFileSize = Number(expectedFileSizeRaw);
  if (!Number.isInteger(expectedFileSize) || expectedFileSize <= 0) {
    throw new CopyDesignMaterializeValidationError("X-Expected-File-Size header must be a positive integer.");
  }

  const originalFileName = headers.originalFileName?.trim();

  return {
    copyDesignOperationId,
    cadDocumentId,
    sourceCadDocumentId,
    documentType: documentTypeRaw as CadDocumentTypeValue,
    originalFileName: originalFileName && originalFileName.length > 0 ? originalFileName : null,
    expectedSha256,
    expectedFileSize,
  };
}

export interface CopyDesignMaterializeResultDto {
  cadDocumentId: string;
  fileVersionId: string;
  versionNumber: number;
  fileName: string;
  fileSize: number;
  sha256: string;
  copyDesignOperationId: string;
}
