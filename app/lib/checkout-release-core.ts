/**
 * Arch PDM - Undo Checkout + Admin Unlock core (P3C-3, provider-agnostic).
 *
 * Pure module: no `@/` imports, no Prisma, no framework - only the type
 * system. Holds the domain errors, result shapes, and the reason/comment
 * normalization rules for both terminal-release operations. All
 * transactional/Prisma logic lives in `app/lib/checkout-release-db.ts`.
 *
 * SCOPE (P3C-3): these are the other two ways (besides Check-In, P3C-2) an
 * active CadCheckout is ever removed:
 *   - Undo Checkout: the checkout's OWNER voluntarily releases it;
 *   - Admin Unlock: an ADMIN forcibly releases someone ELSE's checkout.
 * Neither creates a FileVersion, touches stored binaries, or mutates
 * ItemRevision/lifecycle state - see `checkout-release-db.ts`'s module
 * comment for why. No leases, heartbeats, or automatic expiration exist or
 * are planned here.
 */

export class CadDocumentNotFoundError extends Error {
  constructor() {
    super("CAD document not found in your organization");
    this.name = "CadDocumentNotFoundError";
  }
}

export class UndoCheckoutRoleError extends Error {
  constructor() {
    super("Your role does not permit releasing a CAD document checkout");
    this.name = "UndoCheckoutRoleError";
  }
}

export class AdminUnlockRoleError extends Error {
  constructor() {
    super("Only an administrator can force-unlock another user's checkout");
    this.name = "AdminUnlockRoleError";
  }
}

/** Thrown when there is no active checkout at all - never checked out,
 *  already released, or (the losing side of a race) another terminal
 *  operation already consumed it. Never treated as success. */
export class NotCheckedOutError extends Error {
  constructor() {
    super("This CAD document is not currently checked out");
    this.name = "NotCheckedOutError";
  }
}

/** Thrown when Undo Checkout is attempted by anyone other than the
 *  checkout's own owner. Carries only tenant-safe display information -
 *  Admin Unlock exists precisely so a NON-owner has a controlled path;
 *  Undo Checkout itself never bypasses ownership. */
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

/** Thrown only after the row-locked SERIALIZABLE transaction exhausted its
 *  bounded retries under genuine concurrent load. Never carries Prisma
 *  internals - maps to a controlled 409. */
export class CheckoutReleaseConcurrencyConflictError extends Error {
  constructor() {
    super(
      "Could not complete the operation due to concurrent changes, please retry",
    );
    this.name = "CheckoutReleaseConcurrencyConflictError";
  }
}

export class InvalidReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReasonError";
  }
}

// ------------------------------------------------------------
// Reason / comment normalization
// ------------------------------------------------------------

// Control characters: NUL..US (0x00-0x1F) plus DEL (0x7F).
const CONTROL_CHAR_CLASS = "[\u0000-\u001F\u007F]";
const ALL_CONTROL_CHARS = new RegExp(CONTROL_CHAR_CLASS, "g");

/** Generous but bounded - a reason is a short human sentence, never a
 *  document. Also serves as a cheap guard against a huge arbitrary payload
 *  being stuffed into audit history. */
export const MAX_REASON_LENGTH = 1000;

/** Strip control characters and surrounding whitespace. Never a place to
 *  detect/redact secrets - callers should not be typing them here, and this
 *  module does not attempt content inspection beyond basic sanitization. */
function cleanReason(raw: string): string {
  return raw.replace(ALL_CONTROL_CHARS, "").trim();
}

/**
 * Normalize an OPTIONAL reason (Undo Checkout). `undefined`/`null`/empty
 * (after trimming) all normalize to `null` - a reason is never required
 * here.
 *
 * @throws InvalidReasonError if `raw` is present but not a string, or
 *   exceeds MAX_REASON_LENGTH after cleaning.
 */
export function normalizeOptionalReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new InvalidReasonError("Reason must be a string");
  }
  const cleaned = cleanReason(raw);
  if (cleaned.length === 0) {
    return null;
  }
  if (cleaned.length > MAX_REASON_LENGTH) {
    throw new InvalidReasonError(
      `Reason must be ${MAX_REASON_LENGTH} characters or fewer`,
    );
  }
  return cleaned;
}

/**
 * Normalize a REQUIRED, non-empty reason (Admin Unlock).
 *
 * @throws InvalidReasonError if `raw` is missing, not a string, empty after
 *   trimming, or exceeds MAX_REASON_LENGTH.
 */
export function normalizeRequiredReason(raw: unknown): string {
  const cleaned = normalizeOptionalReason(raw);
  if (!cleaned) {
    throw new InvalidReasonError(
      "A non-empty reason is required to force-unlock a checkout",
    );
  }
  return cleaned;
}

// ------------------------------------------------------------
// Result shapes
// ------------------------------------------------------------

export interface CheckoutReleaseResult {
  cadDocumentId: string;
  checkoutId: string;
  baseFileVersionId: string;
  /** The actor who HELD the checkout before this release. */
  previousOwnerId: string;
  eventId: string;
  reason: string | null;
}

// ------------------------------------------------------------
// History
// ------------------------------------------------------------

/** Hard cap on how many history rows a single request can ever return -
 *  bounded regardless of what the caller asks for. */
export const MAX_HISTORY_LIMIT = 50;
export const DEFAULT_HISTORY_LIMIT = 20;

export interface CheckoutHistoryEntry {
  id: string;
  cadDocumentId: string;
  checkoutId: string;
  baseFileVersionId: string;
  baseVersionNumber: number;
  checkoutOwnerId: string;
  actedById: string;
  eventType: string;
  checkedOutAt: string;
  occurredAt: string;
  reason: string | null;
}

/** Clamp a caller-supplied `limit` into `[1, MAX_HISTORY_LIMIT]`, defaulting
 *  to `DEFAULT_HISTORY_LIMIT` for anything missing or non-numeric. Never
 *  lets a caller request an unbounded query. */
export function resolveHistoryLimit(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(Math.floor(parsed), MAX_HISTORY_LIMIT);
}
