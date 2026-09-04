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
 * never touches CadDependency or stored binaries. There is no undo, admin
 * unlock, or automatic expiration in this milestone - see `checkout-db.ts`
 * for the concurrency strategy (a unique constraint for actor-vs-actor
 * conflicts, plus - since P3C-2 - a CadDocument row lock shared with direct
 * upload and Check-In).
 *
 * VERSION RESOLUTION (P3C-2): the "current usable FileVersion" algorithm is
 * shared with Get Latest and Check-In via `file-version-resolution-core.ts` -
 * see that module's doc comment. This file no longer maintains its own copy;
 * the types/function below are thin aliases kept for call-site stability.
 */
import {
  resolveCurrentFileVersion,
  type FileVersionResolutionRow,
} from "./file-version-resolution-core.ts";

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

/** Thrown only after the CadDocument-row-locked SERIALIZABLE transaction
 *  (shared with direct FileVersion upload - see `db-concurrency-db.ts`)
 *  exhausted its bounded retries under genuine concurrent load. Never
 *  carries Prisma internals - a safe, controlled conflict distinct from
 *  `CheckoutConflictError` (which means "someone else already holds it"). */
export class CheckoutConcurrencyConflictError extends Error {
  constructor() {
    super(
      "Could not complete checkout due to concurrent changes, please retry",
    );
    this.name = "CheckoutConcurrencyConflictError";
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

export { DEFAULT_MAX_VERSIONS_SCANNED } from "./file-version-resolution-core.ts";

export type CheckoutVersionRow = FileVersionResolutionRow;

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

/**
 * Resolve the CadDocument's current usable FileVersion - see
 * `file-version-resolution-core.ts` for the exact (shared) semantics. A
 * checkout's base must always represent the document's true current state,
 * exactly like Get Latest never ships stale bytes labeled "latest".
 */
export async function resolveLatestBinaryVersionForCheckout(
  cadDocumentId: string,
  deps: CheckoutVersionDeps,
): Promise<CheckoutVersionResolution> {
  return resolveCurrentFileVersion<CheckoutVersionRow>(cadDocumentId, deps);
}
