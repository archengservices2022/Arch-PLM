/**
 * Arch PLM - login throttling (WP-2A, item 2A-1).
 *
 * Product Owner decision PD-2A-1/2 (2026-11-18): per account (normalized
 * email), after 5 failed sign-in attempts within 15 minutes the account is
 * temporarily refused with an increasing wait - 1, 2, 4, 8, then at most
 * 15 minutes for each further failure while failures keep accumulating in the
 * window. A successful sign-in clears the account's record.
 *
 * Shared by BOTH sign-in paths (the browser's NextAuth credentials provider in
 * `auth.ts` and the CAD Connect desktop login in `desktop-auth-db.ts`) through
 * one process-wide instance, so attempts on either path count together.
 *
 * CONCURRENCY (Codex WP2A-H1): an attempt is RESERVED synchronously by
 * `beginAttempt()` before any await (user lookup, bcrypt). In-flight attempts
 * count toward the limit together with the failures in the window, so N
 * parallel requests can never get more than `maxFailures` password checks per
 * cycle; after a block has ended only ONE attempt at a time is admitted (its
 * failure re-blocks with the doubled wait). Every admitted attempt must be
 * settled exactly once:
 * `recordFailure()`, `recordSuccess()` or `cancelAttempt()` (an unexpected
 * error that says nothing about the password).
 *
 * MEMORY (Codex WP2A-M1): tracked accounts are bounded. Only EXPIRED entries
 * (no failures in the window, not blocked, nothing in flight) are ever evicted
 * - an account with recent failures or a block is never dropped, so flooding
 * the throttle with other e-mail addresses cannot reset a victim's counter.
 * If the table is full of live entries, attempts for NEW accounts are refused
 * (fail safe) until entries expire.
 *
 * Scope / limitation (accepted by the PO): state is kept in this server
 * process's memory. It resets when the server restarts and is not shared
 * between several server instances. A database-backed throttle needs a schema
 * change and is a separate, later decision (multi-server deployment).
 *
 * Pure module: no I/O, no Prisma, no "server-only" (only node:crypto) -
 * testable with the plain Node test runner. Time is injected for
 * deterministic tests.
 */
import { createHash } from "node:crypto";

export interface LoginThrottlePolicy {
  /** Failures are counted within this sliding window. */
  windowMs: number;
  /** Failures (plus in-flight attempts) within the window that are allowed before refusing. */
  maxFailures: number;
  /** First block duration; doubles for each further block in the same failure streak. */
  baseBlockMs: number;
  /** Upper bound for any single block. */
  maxBlockMs: number;
  /** Bound on tracked accounts (memory safety). */
  maxTrackedKeys: number;
}

export const DEFAULT_LOGIN_THROTTLE_POLICY: LoginThrottlePolicy = Object.freeze({
  windowMs: 15 * 60_000,
  maxFailures: 5,
  baseBlockMs: 60_000,
  maxBlockMs: 15 * 60_000,
  maxTrackedKeys: 100_000,
});

export type LoginThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/** Retry hint when an attempt is refused only because other attempts for the
 *  same account are still being checked (no block in force yet). */
const IN_FLIGHT_RETRY_SECONDS = 1;
/** Retry hint when the tracking table is full of live entries. */
const TABLE_FULL_RETRY_SECONDS = 60;

interface Entry {
  /** Timestamps (ms) of failures inside the window, oldest first; at most maxFailures kept. */
  failures: number[];
  /** Attempts admitted by beginAttempt() and not yet settled. */
  inFlight: number;
  /** How many blocks have been applied in the current failure streak. */
  level: number;
  /** Block end (ms since epoch); 0 when not blocked. */
  blockedUntil: number;
}

/**
 * Fixed-size throttle key for an account: `login:` + SHA-256 (hex) of the
 * normalized (trimmed, lower-case) e-mail. Codex WP2A-N1: hashing bounds the
 * memory per tracked account regardless of how long a submitted "e-mail" is,
 * and the raw address is never stored in the throttle.
 */
export function loginThrottleKey(email: string): string {
  return `login:${createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex")}`;
}

export class LoginThrottle {
  readonly #policy: LoginThrottlePolicy;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(policy: LoginThrottlePolicy = DEFAULT_LOGIN_THROTTLE_POLICY, now: () => number = () => Date.now()) {
    if (!(policy.maxFailures >= 1) || !(policy.windowMs > 0) || !(policy.baseBlockMs > 0) ||
        !(policy.maxBlockMs >= policy.baseBlockMs) || !(policy.maxTrackedKeys >= 1)) {
      throw new Error("Invalid login throttle policy");
    }
    this.#policy = policy;
    this.#now = now;
  }

  /**
   * Read-only: would an attempt be refused because a block is in force?
   * (Does not reserve anything - sign-in paths must use beginAttempt.)
   */
  check(key: string): LoginThrottleDecision {
    const entry = this.#entries.get(key);
    if (!entry) return { allowed: true };
    const now = this.#now();
    if (entry.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
    }
    return { allowed: true };
  }

  /**
   * Atomically reserve a sign-in attempt for this account, BEFORE any await.
   * Refused while a block is in force, or when failures in the window plus
   * attempts already in flight reach `maxFailures`, or (for an untracked
   * account) when the table is full of live entries.
   */
  beginAttempt(key: string): LoginThrottleDecision {
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (entry) {
      this.#prune(entry, now);
      if (entry.blockedUntil > now) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
      }
      if (entry.level > 0) {
        // After a block has ended (same failure streak): ONE attempt at a time.
        // Its failure re-blocks with the doubled wait; parallel requests are refused.
        if (entry.inFlight > 0) return { allowed: false, retryAfterSeconds: IN_FLIGHT_RETRY_SECONDS };
      } else if (entry.failures.length + entry.inFlight >= this.#policy.maxFailures) {
        return { allowed: false, retryAfterSeconds: IN_FLIGHT_RETRY_SECONDS };
      }
    } else {
      if (!this.#makeRoom(now)) {
        return { allowed: false, retryAfterSeconds: TABLE_FULL_RETRY_SECONDS };
      }
      entry = { failures: [], inFlight: 0, level: 0, blockedUntil: 0 };
      this.#entries.set(key, entry);
    }
    entry.inFlight += 1;
    return { allowed: true };
  }

  /** Settle an admitted attempt as a failure (wrong password, unknown/inactive account - all the same). */
  recordFailure(key: string): void {
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (!entry) {
      // Settling after the entry vanished (e.g. a concurrent success). Track it again if possible.
      if (!this.#makeRoom(now)) return;
      entry = { failures: [], inFlight: 0, level: 0, blockedUntil: 0 };
      this.#entries.set(key, entry);
    }
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    this.#prune(entry, now);
    entry.failures.push(now);
    while (entry.failures.length > this.#policy.maxFailures) entry.failures.shift();
    if (entry.failures.length >= this.#policy.maxFailures) {
      const blockMs = Math.min(this.#policy.baseBlockMs * 2 ** entry.level, this.#policy.maxBlockMs);
      entry.level += 1;
      entry.blockedUntil = now + blockMs;
    }
  }

  /** Settle an admitted attempt as a success: the account's failure record is cleared. */
  recordSuccess(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.failures = [];
    entry.level = 0;
    entry.blockedUntil = 0;
    if (entry.inFlight === 0) this.#entries.delete(key);
  }

  /** Release an admitted attempt that ended without a password verdict (unexpected error). */
  cancelAttempt(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    this.#prune(entry, this.#now());
    if (this.#isExpired(entry, this.#now())) this.#entries.delete(key);
  }

  /** Number of tracked accounts (tests / diagnostics). */
  get size(): number {
    return this.#entries.size;
  }

  #prune(entry: Entry, now: number): void {
    const cutoff = now - this.#policy.windowMs;
    while (entry.failures.length > 0 && entry.failures[0]! <= cutoff) entry.failures.shift();
    // A quiet window (no recent failures, not blocked) ends the streak.
    if (entry.failures.length === 0 && entry.blockedUntil <= now) {
      entry.level = 0;
      entry.blockedUntil = 0;
    }
  }

  #isExpired(entry: Entry, now: number): boolean {
    return entry.inFlight === 0 && entry.failures.length === 0 && entry.blockedUntil <= now;
  }

  /** Ensure there is room for one more account. Only EXPIRED entries are ever evicted. */
  #makeRoom(now: number): boolean {
    if (this.#entries.size < this.#policy.maxTrackedKeys) return true;
    for (const [key, entry] of this.#entries) {
      this.#prune(entry, now);
      if (this.#isExpired(entry, now)) this.#entries.delete(key);
    }
    return this.#entries.size < this.#policy.maxTrackedKeys;
  }
}

/**
 * The one process-wide throttle shared by the browser and desktop sign-in
 * paths. Kept on `globalThis` (the same pattern as `app/lib/prisma.ts`) so
 * that even if the bundler instantiates this module more than once - e.g. per
 * route entry or server layer - every sign-in path still uses ONE counter set.
 */
const SHARED_KEY = Symbol.for("arch-plm.login-throttle.v1");

export function getSharedLoginThrottle(): LoginThrottle {
  const g = globalThis as unknown as Record<symbol, LoginThrottle | undefined>;
  let shared = g[SHARED_KEY];
  if (!shared) {
    shared = new LoginThrottle();
    g[SHARED_KEY] = shared;
  }
  return shared;
}
