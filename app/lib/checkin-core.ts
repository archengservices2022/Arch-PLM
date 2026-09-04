/**
 * Arch PDM - CAD Check-In core (P3C-2, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds the check-in-specific domain errors and result shapes. All
 * transactional/storage logic lives in `app/lib/checkin-db.ts`, which
 * composes this module with Prisma and the EXISTING P3A storage
 * architecture (`app/lib/storage-core.ts`'s `uploadCadFileVersion`) - this
 * module does not re-implement or duplicate any storage or version-
 * allocation logic.
 *
 * SCOPE (P3C-2): check-in is the ONLY way, in this milestone, that an active
 * CadCheckout is ever removed. There is no Undo Checkout or Admin Unlock
 * yet. A successful check-in creates exactly one new FileVersion and removes
 * the checkout; ANY failure leaves the checkout exactly as it was.
 */

export class CadDocumentNotFoundError extends Error {
  constructor() {
    super("CAD document not found in your organization");
    this.name = "CadDocumentNotFoundError";
  }
}

export class CheckInRoleError extends Error {
  constructor() {
    super("Your role does not permit checking in CAD documents");
    this.name = "CheckInRoleError";
  }
}

/** Thrown when there is no active checkout at all - already checked in,
 *  never checked out, or (the losing side of a race) the winner's check-in
 *  already removed it. Never treated as success. */
export class NotCheckedOutError extends Error {
  constructor() {
    super("This CAD document is not currently checked out");
    this.name = "NotCheckedOutError";
  }
}

/** Thrown when a DIFFERENT actor holds the active checkout. Carries only
 *  tenant-safe display information about who holds it. */
export class CheckoutOwnershipError extends Error {
  readonly checkedOutById: string;
  readonly checkedOutByName: string;
  readonly checkedOutByEmail: string;
  constructor(info: {
    checkedOutById: string;
    checkedOutByName: string;
    checkedOutByEmail: string;
  }) {
    super("This CAD document is checked out by another user");
    this.name = "CheckoutOwnershipError";
    this.checkedOutById = info.checkedOutById;
    this.checkedOutByName = info.checkedOutByName;
    this.checkedOutByEmail = info.checkedOutByEmail;
  }
}

/** Thrown when the document's current newest FileVersion no longer matches
 *  the checkout's recorded base - defense in depth even though checkout
 *  should normally prevent this (see the module doc comment in
 *  checkin-db.ts). Never creates a new version from a stale base; the
 *  checkout is left untouched. */
export class StaleBaseError extends Error {
  readonly expectedBaseFileVersionId: string;
  readonly actualLatestFileVersionId: string | null;
  constructor(
    expectedBaseFileVersionId: string,
    actualLatestFileVersionId: string | null,
  ) {
    super(
      "The CAD document changed after checkout began; check-in was refused to avoid discarding a newer version",
    );
    this.name = "StaleBaseError";
    this.expectedBaseFileVersionId = expectedBaseFileVersionId;
    this.actualLatestFileVersionId = actualLatestFileVersionId;
  }
}

/** Defense-in-depth only - see the long comment above
 *  `persistFileVersionRow` in checkin-db.ts for why this should be
 *  unreachable in practice. Recognized by `isVersionNumberConflict` so
 *  `uploadCadFileVersion`'s existing retry-with-a-fresh-candidate loop
 *  handles it exactly like any other version-number race. */
export class CheckInVersionRaceError extends Error {
  constructor() {
    super("File version number changed concurrently, retrying");
    this.name = "CheckInVersionRaceError";
  }
}

/** Thrown only after the row-locked SERIALIZABLE transaction exhausted its
 *  bounded retries under genuine concurrent load (Postgres P2034/deadlock).
 *  Never carries Prisma internals - maps to a controlled 409. The checkout
 *  is guaranteed untouched (the transaction that hit this never committed)
 *  and any promoted storage object for this attempt is compensated exactly
 *  like any other post-promotion failure. */
export class CheckInConcurrencyConflictError extends Error {
  constructor() {
    super(
      "Could not complete check-in due to concurrent changes, please retry",
    );
    this.name = "CheckInConcurrencyConflictError";
  }
}

export interface CheckInResult {
  fileVersionId: string;
  cadDocumentId: string;
  versionNumber: number;
  originalFileName: string;
  storageKey: string;
  fileSize: number;
  checksum: string;
  createdById: string;
}
