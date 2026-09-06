/**
 * Arch PDM - reference CLI client: released-plan -> WorkspacePlan adapter
 * (P3D-2).
 *
 * `app/lib/workspace-materialize-core.ts` (P3B-2B) is intentionally left
 * UNMODIFIED - it type-checks its input as the EXACT `WorkspacePlan`
 * contract (`app/lib/workspace-plan-core.ts`) and only ever reads
 * `plan.contract`, `plan.safe`, and `plan.entries` (never `plan.root` or
 * `plan.traversal`). A `ReleasedWorkspacePlan`
 * (`app/lib/released-workspace-core.ts`) is deliberately NOT that same
 * contract - it identifies itself by ItemRevision + ReleaseBaseline, not by
 * a single graph "root" CadDocument, since P3D-2 does no dependency-graph
 * traversal. This adapter is the ONLY place that bridges the two: it
 * repackages a `ReleasedWorkspacePlan`'s (already fully verified, always
 * `canMaterialize: true`) entries into a `WorkspacePlan`-shaped value so the
 * EXISTING materializer can consume it without any change to that module.
 *
 * `root.cadDocumentId` on the adapted value is NOT a real CadDocument id -
 * it is set to the ItemRevision id purely so the materializer's required
 * field is present. The materializer never reads it. This is COMPATIBILITY
 * ONLY: the value MUST NOT be interpreted, logged, displayed, or exposed
 * anywhere as CadDocument identity - the authoritative identities remain
 * `released.itemRevision.id` / `released.releaseBaseline.id` / each entry's
 * own `cadDocumentId`, all still present, untouched, on `entries` below.
 *
 * This function is an internal bridge for THIS CLI only (its sole
 * production caller is `orchestrate-workspace-get-released.ts`; tests
 * import it directly to verify the bridge itself) - it is not, and must not
 * become, a general-purpose or publicly documented conversion API. Do not
 * import it from `app/lib/**` or treat its output as anything other than a
 * disposable value fed straight into `materializeWorkspacePlan`.
 */
import {
  WORKSPACE_PLAN_CONTRACT_ID,
  WORKSPACE_PLAN_CONTRACT_VERSION,
  type WorkspacePlan,
} from "../app/lib/workspace-plan-core.ts";
import type { ReleasedWorkspacePlan } from "../app/lib/released-workspace-core.ts";

/**
 * Convert an already-fetched, already-validated `ReleasedWorkspacePlan` into
 * a `WorkspacePlan` the existing, unmodified materializer can consume.
 * Pure, synchronous, no I/O - every fact was already produced by the
 * released-workspace endpoint.
 */
export function toMaterializableWorkspacePlan(
  released: ReleasedWorkspacePlan,
): WorkspacePlan {
  return {
    // Deliberately NOT released.contract - the materializer only accepts
    // its OWN known contract id/version; a released plan is bridged INTO
    // that shape here, not passed through as its own distinct identity.
    contract: { id: WORKSPACE_PLAN_CONTRACT_ID, version: WORKSPACE_PLAN_CONTRACT_VERSION },
    root: { cadDocumentId: released.itemRevision.id },
    generatedAt: released.generatedAt,
    documentCount: released.documentCount,
    safe: released.safe,
    entries: released.entries,
    problems: released.problems,
    traversal: {
      visitedCount: released.entries.length,
      edgeCount: 0,
      maxNodes: released.entries.length,
    },
  };
}
