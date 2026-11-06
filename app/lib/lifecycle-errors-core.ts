// ============================================================
// Arch PLM - typed lifecycle state errors (pilot UX fix KI-2)
//
// Pure: no I/O. `advanceRevisionForActor` (release-db.ts) throws these for
// the non-permission refusals it has always made - revision not found,
// terminal revision, a transition that is not allowed from the CURRENT state
// (typically a stale form), a concurrent change, and exhausted retries.
//
// The messages are byte-for-byte the messages these refusals have always
// carried, so every existing caller and test that matches on the message is
// unaffected. The class only adds a stable `code`, so the dashboard can show
// a fixed, allowlisted message instead of an error page.
//
// Like every other refusal in advanceRevisionForActor, each of these is
// thrown before any write or inside the transaction, so a refusal changes
// nothing.
// ============================================================

export type LifecycleStateErrorCode =
  | "REVISION_NOT_FOUND"
  | "TERMINAL_REVISION"
  | "INVALID_TRANSITION"
  | "CONCURRENT_CHANGE"
  | "RETRY_EXHAUSTED";

export class LifecycleStateError extends Error {
  readonly code: LifecycleStateErrorCode;
  constructor(code: LifecycleStateErrorCode, message: string) {
    super(message);
    this.name = "LifecycleStateError";
    this.code = code;
  }
}
