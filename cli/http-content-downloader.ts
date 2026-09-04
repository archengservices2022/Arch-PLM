/**
 * Arch PDM - reference CLI client: real HTTP ContentDownloader (P3B-2C).
 *
 * Implements the exact `ContentDownloader` interface the P3B-2B materializer
 * already defines (`app/lib/workspace-materialize-core.ts`) using Node's
 * built-in `fetch`. This is the ONLY place in the reference client that
 * issues an HTTP request for CAD binary bytes, and it:
 *   - binds the request to the session's exact origin
 *     (`assertSessionOriginMatches`) BEFORE `session.authHeaders()` is ever
 *     read, so cookies from one origin can never be sent to another;
 *   - sends the caller's `ArchSession` auth headers on every request, so the
 *     authenticated session is preserved across the download;
 *   - streams the response body straight through (`Readable.fromWeb`) -
 *     never buffers a whole CAD file in memory;
 *   - bounds the request with the shared request timeout
 *     (`request-timeout.ts`). Unlike the workspace-plan fetch, the timeout
 *     here stays armed across the ENTIRE streamed download, not just until
 *     headers arrive: if the connection stalls mid-transfer the returned
 *     stream errors out with a clear `RequestTimeoutError` (the P3B-2B
 *     materializer's own staging cleanup then runs exactly as it does for
 *     any other stream failure - nothing here changes that);
 *   - rejects any non-2xx response;
 *   - rejects ANY redirect, same-origin or cross-origin, unconditionally.
 *     `redirect: "manual"` stops `fetch` from ever auto-following one; this
 *     downloader never inspects a `Location` header to decide whether a
 *     particular redirect "looks safe" and follow it - EVERY redirect is a
 *     hard failure;
 *   - accepts ONLY a `contentPath` matching the exact
 *     `/api/file-versions/<fileVersionId>/content` shape and resolves it
 *     strictly against this downloader's own origin - an absolute URL, a
 *     protocol-relative path, or any other shape is refused before any
 *     network call is made. This is on top of (never a substitute for) the
 *     materializer's own `contentPath` pinning check.
 */
import { PassThrough, Readable } from "node:stream";

import type { ContentDownloader } from "../app/lib/workspace-materialize-core.ts";
import { assertSessionOriginMatches, type ArchSession } from "./arch-session.ts";
import { RequestTimeoutError, resolveRequestTimeoutMs } from "./request-timeout.ts";

export class UnsafeContentPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeContentPathError";
  }
}

export class ContentDownloadRedirectError extends Error {
  constructor(url: string) {
    super(`Content download was redirected; refusing to follow: ${url}`);
    this.name = "ContentDownloadRedirectError";
  }
}

export class ContentDownloadHttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`Content download failed: HTTP ${status} for ${url}`);
    this.name = "ContentDownloadHttpError";
    this.status = status;
  }
}

/** The ONLY contentPath shape this downloader will ever fetch. */
const CONTENT_PATH_SHAPE = /^\/api\/file-versions\/[^/?#]+\/content$/;

interface FetchLike {
  (url: string | URL, init?: RequestInit): Promise<Response>;
}

export class HttpContentDownloader implements ContentDownloader {
  readonly #origin: string;
  readonly #session: ArchSession;
  readonly #fetchImpl: FetchLike;
  readonly #timeoutMs: number;

  constructor(
    origin: string,
    session: ArchSession,
    fetchImpl: FetchLike = fetch,
    timeoutMs: number = resolveRequestTimeoutMs(),
  ) {
    this.#origin = origin;
    this.#session = session;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async openContentStream(contentPath: string): Promise<Readable> {
    // Bind to the session's exact origin BEFORE ever reading its auth headers.
    assertSessionOriginMatches(this.#session, this.#origin);

    if (typeof contentPath !== "string" || !CONTENT_PATH_SHAPE.test(contentPath)) {
      throw new UnsafeContentPathError(
        `Refusing to download an unexpected contentPath: ${JSON.stringify(contentPath)}`,
      );
    }

    const url = new URL(contentPath, this.#origin);
    if (url.origin !== this.#origin) {
      // Unreachable given CONTENT_PATH_SHAPE above, but kept as an explicit,
      // independent defense-in-depth check rather than relying on the regex
      // alone.
      throw new UnsafeContentPathError(
        `contentPath resolved outside the Arch server origin: ${url.origin}`,
      );
    }

    // A single AbortController covers the whole lifecycle: connecting,
    // waiting for headers, AND the later streamed body read the caller does
    // after this function returns. It is only disarmed once the returned
    // stream fully ends, errors, or is closed - never merely once headers
    // arrive - so a stall partway through a large download still times out.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let timerCleared = false;
    const clearTimer = (): void => {
      if (!timerCleared) {
        timerCleared = true;
        clearTimeout(timer);
      }
    };

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { ...this.#session.authHeaders() },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimer();
      if (controller.signal.aborted) {
        throw new RequestTimeoutError(url.toString(), this.#timeoutMs);
      }
      throw error;
    }

    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      clearTimer();
      throw new ContentDownloadRedirectError(url.toString());
    }
    if (!response.ok) {
      clearTimer();
      throw new ContentDownloadHttpError(response.status, url.toString());
    }
    if (!response.body) {
      clearTimer();
      throw new Error(`Content response for ${url} had no body`);
    }

    const rawStream = Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );

    // Proxy through a PassThrough so this downloader - not Node's internal
    // stream/abort plumbing - controls exactly what error the caller sees
    // when the shared timeout fires mid-transfer: a clear
    // `RequestTimeoutError`, not a generic AbortError. A PassThrough only
    // ever holds one chunk at a time, so streaming (no whole-file buffering)
    // is preserved.
    const out = new PassThrough();
    rawStream.on("error", (error: unknown) => {
      clearTimer();
      if (controller.signal.aborted) {
        out.destroy(new RequestTimeoutError(url.toString(), this.#timeoutMs));
      } else {
        out.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    rawStream.on("end", clearTimer);
    rawStream.on("close", clearTimer);
    out.on("close", clearTimer);
    rawStream.pipe(out);

    return out;
  }
}
