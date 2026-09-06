/**
 * Arch PDM - reference CLI client: released-revision orchestration (P3D-2).
 *
 * Mirrors `orchestrate-workspace-get.ts` exactly, but for a RELEASED
 * ItemRevision: fetches the frozen `ReleasedWorkspacePlan`
 * (`released-workspace-plan-client.ts`), bridges it into the exact
 * `WorkspacePlan` shape the EXISTING, UNMODIFIED P3B-2B materializer expects
 * (`released-workspace-adapter.ts`), then hands it to that same
 * materializer unchanged. The real HTTP `ContentDownloader` and local
 * filesystem provider are the SAME P3B-2C components the working Get uses -
 * nothing about downloading or placing bytes differs for a released
 * retrieval.
 */
import { win32 as pathWin32 } from "node:path";

import {
  LocalWorkspaceFs,
  materializeWorkspacePlan,
  WorkspaceRootError,
  type MaterializationReport,
} from "../app/lib/workspace-materialize-core.ts";
import { fetchReleasedWorkspacePlan } from "./released-workspace-plan-client.ts";
import { toMaterializableWorkspacePlan } from "./released-workspace-adapter.ts";
import { HttpContentDownloader } from "./http-content-downloader.ts";
import { assertHttpOrigin } from "./orchestrate-workspace-get.ts";
import type { ArchSession } from "./arch-session.ts";

export interface ReleasedWorkspaceGetOptions {
  serverUrl: string;
  itemRevisionId: string;
  /** Caller-supplied, trusted, ABSOLUTE workspace root - never derived from
   *  the plan or any server response. */
  workspaceRoot: string;
  session: ArchSession;
}

/**
 * Run the full released Get -> materialize protocol once, end to end.
 *
 * @throws InvalidServerUrlError for a non-http(s) server URL.
 * @throws WorkspaceRootError for a relative workspace root.
 * @throws ReleasedWorkspacePlanRedirectError / ReleasedWorkspacePlanRequestError /
 *   UnsupportedReleasedWorkspaceContractError from the plan fetch/validation
 *   step - nothing is downloaded or written if any of these are thrown
 *   (this includes the server's 409/422 controlled integrity failures,
 *   which surface as a ReleasedWorkspacePlanRequestError here).
 * @returns a MaterializationReport - per-entry download/failure/conflict
 *   outcomes are reported there, never thrown.
 */
export async function runReleasedWorkspaceGet(
  options: ReleasedWorkspaceGetOptions,
): Promise<MaterializationReport> {
  const origin = assertHttpOrigin(options.serverUrl);

  if (!pathWin32.isAbsolute(options.workspaceRoot)) {
    throw new WorkspaceRootError(
      `Workspace root must be an absolute path: ${JSON.stringify(options.workspaceRoot)}`,
    );
  }

  const released = await fetchReleasedWorkspacePlan(
    origin,
    options.itemRevisionId,
    options.session,
  );
  const plan = toMaterializableWorkspacePlan(released);

  const downloader = new HttpContentDownloader(origin, options.session);
  const fs = new LocalWorkspaceFs(options.workspaceRoot);

  return materializeWorkspacePlan(plan, options.workspaceRoot, {
    downloader,
    fs,
  });
}
