/**
 * Arch PDM - reference CLI client: workspace-plan request + validation
 * (P3B-2C).
 *
 * Fetches the versioned Managed Workspace Plan contract from the EXISTING
 * authenticated endpoint (`GET /api/cad-documents/:id/workspace-plan`) and
 * validates it before it is ever handed to the materializer:
 *   - binds the request to the session's exact origin
 *     (`assertSessionOriginMatches`) BEFORE `session.authHeaders()` is ever
 *     read, so cookies from one origin can never be sent to another;
 *   - rejects ANY redirect, same-origin or cross-origin, unconditionally
 *     (`redirect: "manual"` so `fetch` never auto-follows one; every 3xx
 *     response is treated as a hard failure rather than inspected/followed);
 *   - bounds the whole request (connect + read the JSON body) with the
 *     shared request timeout (`request-timeout.ts`), reported as a clear
 *     `RequestTimeoutError` rather than a hang or a generic abort;
 *   - rejects a non-2xx response;
 *   - rejects a body that doesn't match the expected contract shape;
 *   - rejects an unrecognized contract id, or an unsupported contract
 *     version (reusing the EXACT check the materializer itself enforces -
 *     `isSupportedWorkspaceContractVersion`);
 *   - refuses an unsafe/incomplete plan (`safe !== true`).
 *
 * This is intentionally the ONLY server endpoint this reference client ever
 * calls to obtain a package definition. Get Latest is never called
 * separately - the workspace plan already IS the complete, tenant-safe,
 * version-pinned operation contract for this Get.
 */
import {
  isSupportedWorkspaceContractVersion,
  UnsafeWorkspacePlanError,
  UnsupportedWorkspaceContractError,
} from "../app/lib/workspace-materialize-core.ts";
import {
  WORKSPACE_PLAN_CONTRACT_ID,
  type WorkspacePlan,
} from "../app/lib/workspace-plan-core.ts";
import { assertSessionOriginMatches, type ArchSession } from "./arch-session.ts";
import { resolveRequestTimeoutMs, withRequestTimeout } from "./request-timeout.ts";

export class WorkspacePlanRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePlanRequestError";
  }
}

export class WorkspacePlanRedirectError extends Error {
  constructor(url: string) {
    super(`workspace-plan request was redirected; refusing to follow: ${url}`);
    this.name = "WorkspacePlanRedirectError";
  }
}

interface FetchLike {
  (url: string | URL, init?: RequestInit): Promise<Response>;
}

function assertWorkspacePlanShape(body: unknown): asserts body is WorkspacePlan {
  const p = body as
    | {
        contract?: { id?: unknown; version?: unknown };
        root?: { cadDocumentId?: unknown };
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
    typeof p.safe !== "boolean" ||
    !Array.isArray(p.entries) ||
    typeof p.root !== "object" ||
    p.root === null ||
    typeof p.root.cadDocumentId !== "string"
  ) {
    throw new WorkspacePlanRequestError(
      "workspace-plan response does not match the expected contract shape",
    );
  }
}

/**
 * Fetch and fully validate the workspace plan for `cadDocumentId`.
 *
 * @throws OriginMismatchError (from `arch-session.ts`) if `session.origin`
 *   does not exactly match `origin` - no request is sent.
 * @throws RequestTimeoutError if the request does not complete within the
 *   shared request timeout.
 * @throws WorkspacePlanRedirectError on any redirect.
 * @throws WorkspacePlanRequestError on a non-2xx response or a malformed body.
 * @throws UnsupportedWorkspaceContractError on an unrecognized contract id or
 *   an unsupported contract version.
 * @throws UnsafeWorkspacePlanError when the plan reports `safe !== true`.
 */
export async function fetchWorkspacePlan(
  origin: string,
  cadDocumentId: string,
  session: ArchSession,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = resolveRequestTimeoutMs(),
): Promise<WorkspacePlan> {
  // Bind to the session's exact origin BEFORE ever reading its auth headers.
  assertSessionOriginMatches(session, origin);

  const url = new URL(
    `/api/cad-documents/${encodeURIComponent(cadDocumentId)}/workspace-plan`,
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
    throw new WorkspacePlanRedirectError(url.toString());
  }
  if (!response.ok) {
    throw new WorkspacePlanRequestError(
      `workspace-plan request failed: HTTP ${response.status} for ${url}`,
    );
  }

  const body: unknown = await response.json();
  assertWorkspacePlanShape(body);

  if (body.contract.id !== WORKSPACE_PLAN_CONTRACT_ID) {
    throw new UnsupportedWorkspaceContractError(
      `Unsupported workspace contract id: ${JSON.stringify(body.contract.id)}`,
    );
  }
  if (!isSupportedWorkspaceContractVersion(body.contract.version)) {
    throw new UnsupportedWorkspaceContractError(
      `Unsupported workspace contract version: ${JSON.stringify(body.contract.version)}`,
    );
  }
  if (body.safe !== true) {
    throw new UnsafeWorkspacePlanError();
  }

  return body;
}
