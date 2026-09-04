/**
 * Arch PDM - reference CLI client: shared request timeout (P3B-2C security
 * fix #3).
 *
 * One configurable timeout, shared by both the workspace-plan fetch
 * (`workspace-plan-client.ts`) and every content download
 * (`http-content-downloader.ts`), so a hung/unresponsive Arch server (or a
 * connection that stalls partway through a CAD binary) fails clearly instead
 * of hanging the CLI forever.
 *
 * There is NO automatic retry here: a timeout is reported as a single clear
 * failure and it is up to the caller (a human today, or eventually the
 * future CAD Connect client) to decide whether to try again.
 */

/** Sensible default for local/dev use: generous enough for a slow CAD
 *  binary on a LAN, short enough that a genuinely hung server fails within a
 *  reasonable wait. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve the shared request timeout. Optional override via
 * `ARCH_REQUEST_TIMEOUT_MS` - must be a positive integer; any other value
 * (missing, non-numeric, zero, negative, non-integer) silently falls back to
 * the default rather than disabling the timeout entirely.
 */
export function resolveRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ARCH_REQUEST_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export class RequestTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * Run `fn` with an `AbortSignal` that fires after `timeoutMs`, for a request
 * whose ENTIRE lifecycle (including reading any response body it awaits) is
 * fully contained inside `fn` - e.g. `fetch(...).then(r => r.json())`. If
 * `fn`'s promise rejects because that signal fired, the rejection is
 * normalized into a `RequestTimeoutError` (a bare `fetch` abort otherwise
 * rejects with a generic AbortError that doesn't say "timeout"). The timer is
 * always cleared.
 *
 * NOT suitable for a request whose body is handed back to the CALLER as a
 * stream for later, separate consumption (see `http-content-downloader.ts`,
 * which manages its own `AbortController` so the timeout stays armed across
 * that later streaming instead of being cleared the moment headers arrive).
 */
export async function withRequestTimeout<T>(
  url: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
