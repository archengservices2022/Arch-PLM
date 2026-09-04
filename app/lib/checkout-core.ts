/**
 * Arch PDM - CAD Checkout core (P3C-1, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds:
 *   - the checkout record / outcome / status shapes this milestone's API
 *     exposes;
 *   - the checkout-specific domain errors;
 *   - the "resolve the current newest binary-backed FileVersion, no
 *     fallback" algorithm checkout uses to pick its base version - the SAME
 *     integrity philosophy as Get Latest (`app/lib/get-latest-core.ts`),
 *     independently re-implemented here (not imported) because this module
 *     is deliberately self-contained and scoped to a single CadDocument,
 *     not a whole dependency graph.
 *
 * The database + tenant wiring lives in `app/lib/checkout-db.ts`.
 *
 * SCOPE (P3C-1): checkout is a CadDocument-level editing LOCK only. It never
 * creates a FileVersion, never mutates ItemRevision or lifecycle state, and
 * never touches CadDependency or stored binaries. There is no check-in,
 * undo, admin unlock, or automatic expiration in this milestone - see
 * `checkout-db.ts` for why a single database unique constraint is the entire
 * concurrency strategy under those constraints.
 */

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class CadDocumentNotFoundError extends Error {
  constructor() {
    super("CAD document not found in your organization");
    this.name = "CadDocumentNotFoundError";
  }
}

export class CheckoutRoleError extends Error {
  constructor() {
    super("Your role does not permit checking out CAD documents");
    this.name = "CheckoutRoleError";
  }
}

export class NoValidFileVersionError extends Error {
  constructor() {
    super(
      "This CAD document has no valid stored binary FileVersion to check out",
    );
    this.name = "NoValidFileVersionError";
  }
}

/** Thrown when the CadDocument is already checked out by a DIFFERENT actor.
 *  Carries only tenant-safe lock information - never anything from outside
 *  the caller's own organization, and never a token/secret of any kind. */
export class CheckoutConflictError extends Error {
  readonly checkout: CheckoutRecord;
  constructor(checkout: CheckoutRecord) {
    super("This CAD document is already checked out by another user");
    this.name = "CheckoutConflictError";
    this.checkout = checkout;
  }
}

// ------------------------------------------------------------
// Checkout record / outcome / status shapes
// ------------------------------------------------------------

export interface CheckoutRecord {
  id: string;
  cadDocumentId: string;
  /** Authoritative identity of the EXACT FileVersion editing began from.
   *  Never re-resolved after the checkout is created. */
  baseFileVersionId: string;
  /** Display only - never identity. */
  baseVersionNumber: number;
  /** Authoritative identity of the actor holding the checkout. */
  checkedOutById: string;
  /** Display only - never identity. Safe within the same tenant. */
  checkedOutByName: string;
  checkedOutByEmail: string;
  checkedOutAt: string;
  note: string | null;
}

export type CheckoutRequestOutcome =
  | { status: "created"; checkout: CheckoutRecord }
  | { status: "already-mine"; checkout: CheckoutRecord };

export type CheckoutStatus =
  | { state: "available" }
  | { state: "mine"; checkout: CheckoutRecord }
  | { state: "locked"; checkout: CheckoutRecord };

// ------------------------------------------------------------
// Base-version resolution (no fallback - Get Latest integrity philosophy)
// ------------------------------------------------------------

export const DEFAULT_MAX_VERSIONS_SCANNED = 500;

export interface CheckoutVersionRow {
  id: string;
  versionNumber: number;
  checksum: string | null;
  fileSize: number | null;
  storageKey: string;
}

export interface CheckoutVersionDeps {
  /** Tenant-scoped, newest versionNumber first, already capped by the caller. */
  loadVersionsNewestFirst(cadDocumentId: string): Promise<CheckoutVersionRow[]>;
  /** True when the stored binary object for `storageKey` actually exists. */
  objectExists(storageKey: string): Promise<boolean>;
  maxVersionsScanned?: number;
}

export type CheckoutVersionResolution =
  | { kind: "ok"; row: CheckoutVersionRow }
  | { kind: "missing-version" }
  | { kind: "missing-binary"; row: CheckoutVersionRow };

/** A version row is a real, immutable binary version iff it carries a
 *  server-computed checksum and byte size (the metadata-only creation path
 *  that produced neither was removed in P3A-1). */
function isBinaryBacked(row: CheckoutVersionRow): boolean {
  return (
    typeof row.checksum === "string" &&
    row.checksum.length > 0 &&
    typeof row.fileSize === "number" &&
    Number.isFinite(row.fileSize) &&
    row.fileSize >= 0
  );
}

/**
 * Resolve the CadDocument's current newest binary-backed FileVersion.
 *
 * Newest-first, first metadata-complete (checksum + size) row wins; if that
 * row's bytes are missing from storage, this returns `missing-binary` rather
 * than silently falling back to an older, still-present version - a
 * checkout's base must always represent the document's true current state,
 * exactly like Get Latest never ships stale bytes labeled "latest".
 */
export async function resolveLatestBinaryVersionForCheckout(
  cadDocumentId: string,
  deps: CheckoutVersionDeps,
): Promise<CheckoutVersionResolution> {
  const maxScan = deps.maxVersionsScanned ?? DEFAULT_MAX_VERSIONS_SCANNED;
  const rows = (await deps.loadVersionsNewestFirst(cadDocumentId)).slice(
    0,
    maxScan,
  );

  const latest = rows.find(isBinaryBacked);
  if (!latest) {
    return { kind: "missing-version" };
  }

  const exists = await deps.objectExists(latest.storageKey);
  return exists
    ? { kind: "ok", row: latest }
    : { kind: "missing-binary", row: latest };
}
