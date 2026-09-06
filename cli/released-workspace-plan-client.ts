/**
 * Arch PDM - reference CLI client: released-workspace-plan request +
 * validation (P3D-2).
 *
 * Mirrors `workspace-plan-client.ts` exactly, but for the released-revision
 * endpoint (`GET /api/item-revisions/:id/released-workspace`) and its own
 * `ReleasedWorkspacePlan` contract:
 *   - binds the request to the session's exact origin
 *     (`assertSessionOriginMatches`) BEFORE `session.authHeaders()` is ever
 *     read;
 *   - rejects ANY redirect unconditionally (`redirect: "manual"`);
 *   - bounds the request with the shared request timeout;
 *   - rejects a non-2xx response;
 *   - rejects a body that doesn't match the expected contract shape;
 *   - rejects an unrecognized contract id, or an unsupported contract
 *     version.
 *
 * A released plan's `safe` is always `true` by construction (see
 * `released-workspace-core.ts`) - there is no "unsafe but still returned"
 * case to additionally guard here the way the working workspace-plan client
 * does; an integrity problem on the server surfaces as a non-2xx response
 * instead, which the HTTP status check above already rejects.
 */
import {
  RELEASED_WORKSPACE_CONTRACT_ID,
  isSupportedReleasedWorkspaceContractVersion,
  type ReleasedWorkspacePlan,
} from "../app/lib/released-workspace-core.ts";
import { assertSessionOriginMatches, type ArchSession } from "./arch-session.ts";
import { resolveRequestTimeoutMs, withRequestTimeout } from "./request-timeout.ts";

export class ReleasedWorkspacePlanRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleasedWorkspacePlanRequestError";
  }
}

export class ReleasedWorkspacePlanRedirectError extends Error {
  constructor(url: string) {
    super(`released-workspace request was redirected; refusing to follow: ${url}`);
    this.name = "ReleasedWorkspacePlanRedirectError";
  }
}

export class UnsupportedReleasedWorkspaceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedReleasedWorkspaceContractError";
  }
}

interface FetchLike {
  (url: string | URL, init?: RequestInit): Promise<Response>;
}

function assertReleasedWorkspacePlanShape(
  body: unknown,
): asserts body is ReleasedWorkspacePlan {
  const p = body as
    | {
        contract?: { id?: unknown; version?: unknown };
        itemRevision?: { id?: unknown };
        releaseBaseline?: { id?: unknown };
        safe?: unknown;
        entries?: unknown;
      }
    | null
    | undefined;

  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.contract !== "object" ||
    p.contract === null ||
    typeof p.contract.id !== "string" ||
    typeof p.contract.version !== "string" ||
    typeof p.itemRevision !== "object" ||
    p.itemRevision === null ||
    typeof p.itemRevision.id !== "string" ||
    typeof p.releaseBaseline !== "object" ||
    p.releaseBaseline === null ||
    typeof p.releaseBaseline.id !== "string" ||
    typeof p.safe !== "boolean" ||
    !Array.isArray(p.entries)
  ) {
    throw new ReleasedWorkspacePlanRequestError(
      "released-workspace response does not match the expected contract shape",
    );
  }
}

/**
 * Fetch and fully validate the released-workspace plan for `itemRevisionId`.
 *
 * @throws OriginMismatchError if `session.origin` does not exactly match
 *   `origin` - no request is sent.
 * @throws RequestTimeoutError if the request does not complete within the
 *   shared request timeout.
 * @throws ReleasedWorkspacePlanRedirectError on any redirect.
 * @throws ReleasedWorkspacePlanRequestError on a non-2xx response (this is
 *   also how the server's 409/422 controlled integrity failures surface -
 *   see `app/lib/released-workspace-db.ts`) or a malformed body.
 * @throws UnsupportedReleasedWorkspaceContractError on an unrecognized
 *   contract id or an unsupported contract version.
 */
export async function fetchReleasedWorkspacePlan(
  origin: string,
  itemRevisionId: string,
  session: ArchSession,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = resolveRequestTimeoutMs(),
): Promise<ReleasedWorkspacePlan> {
  assertSessionOriginMatches(session, origin);

  const url = new URL(
    `/api/item-revisions/${encodeURIComponent(itemRevisionId)}/released-workspace`,
    origin,
  );

  const response = await withRequestTimeout(url.toString(), timeoutMs, (signal) =>
    fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { ...session.authHeaders(), accept: "application/json" },
      signal,
    }),
  );

  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new ReleasedWorkspacePlanRedirectError(url.toString());
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof detail?.error === "string" ? detail.error : `HTTP ${response.status}`;
    throw new ReleasedWorkspacePlanRequestError(
      `released-workspace request failed: ${message} for ${url}`,
    );
  }

  const body: unknown = await response.json();
  assertReleasedWorkspacePlanShape(body);

  if (body.contract.id !== RELEASED_WORKSPACE_CONTRACT_ID) {
    throw new UnsupportedReleasedWorkspaceContractError(
      `Unsupported released-workspace contract id: ${JSON.stringify(body.contract.id)}`,
    );
  }
  if (!isSupportedReleasedWorkspaceContractVersion(body.contract.version)) {
    throw new UnsupportedReleasedWorkspaceContractError(
      `Unsupported released-workspace contract version: ${JSON.stringify(body.contract.version)}`,
    );
  }

  return body;
}
