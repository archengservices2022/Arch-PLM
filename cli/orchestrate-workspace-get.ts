/**
 * Arch PDM - reference CLI client: orchestration (P3B-2C).
 *
 * Wires together an authenticated `ArchSession`, the workspace-plan fetch +
 * validation (`workspace-plan-client.ts`), the real HTTP `ContentDownloader`
 * (`http-content-downloader.ts`), and the EXISTING, UNMODIFIED P3B-2B
 * materializer (`app/lib/workspace-materialize-core.ts`). This is the
 * reference implementation of the full protocol:
 *
 *   authenticated Arch user -> workspace-plan endpoint -> exact pinned
 *   FileVersion content endpoints -> streamed verified downloads -> managed
 *   local workspace.
 *
 * It never calls Get Latest separately - the workspace plan already IS the
 * complete operation contract - and it never re-resolves "latest" partway
 * through: the SAME plan object, fetched exactly once, is handed to the
 * materializer unmodified.
 */
import { win32 as pathWin32 } from "node:path";

import {
  LocalWorkspaceFs,
  materializeWorkspacePlan,
  WorkspaceRootError,
  type MaterializationReport,
} from "../app/lib/workspace-materialize-core.ts";
import { fetchWorkspacePlan } from "./workspace-plan-client.ts";
import { HttpContentDownloader } from "./http-content-downloader.ts";
import type { ArchSession } from "./arch-session.ts";

export class InvalidServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidServerUrlError";
  }
}

/** Parse `serverUrl` and reject anything but a plain http/https origin - no
 *  other scheme (`file:`, `ftp:`, ...) is ever accepted. */
export function assertHttpOrigin(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new InvalidServerUrlError(`Invalid server URL: ${JSON.stringify(serverUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidServerUrlError(
      `Server URL must use http or https, got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  return parsed.origin;
}

export interface WorkspaceGetOptions {
  serverUrl: string;
  cadDocumentId: string;
  /** Caller-supplied, trusted, ABSOLUTE workspace root - never derived from
   *  the plan or any server response. */
  workspaceRoot: string;
  session: ArchSession;
}

/**
 * Run the full Get -> materialize protocol once, end to end.
 *
 * @throws InvalidServerUrlError for a non-http(s) server URL.
 * @throws WorkspaceRootError for a relative workspace root.
 * @throws WorkspacePlanRedirectError / WorkspacePlanRequestError /
 *   UnsupportedWorkspaceContractError / UnsafeWorkspacePlanError from the
 *   workspace-plan fetch/validation step - nothing is downloaded or written
 *   if any of these are thrown.
 * @returns a MaterializationReport - per-entry download/failure/conflict
 *   outcomes are reported there, never thrown.
 */
export async function runWorkspaceGet(
  options: WorkspaceGetOptions,
): Promise<MaterializationReport> {
  const origin = assertHttpOrigin(options.serverUrl);

  if (!pathWin32.isAbsolute(options.workspaceRoot)) {
    throw new WorkspaceRootError(
      `Workspace root must be an absolute path: ${JSON.stringify(options.workspaceRoot)}`,
    );
  }

  const plan = await fetchWorkspacePlan(
    origin,
    options.cadDocumentId,
    options.session,
  );

  const downloader = new HttpContentDownloader(origin, options.session);
  const fs = new LocalWorkspaceFs(options.workspaceRoot);

  return materializeWorkspacePlan(plan, options.workspaceRoot, {
    downloader,
    fs,
  });
}
