/**
 * Arch PDM - B06 G-3: remove a CAD structure link (CadDependency).
 *
 * PO-signed B06 plan Rev1, decision G-3(a). Without removal, the per-release
 * structure procedure could not correct a link that is wrong or out of date
 * (a component taken out of an assembly).
 *
 * RULES
 *  - Authorization stays in the Server Action (write roles only:
 *    refuseUnlessWriteRole + assertCanMutate); this module receives the
 *    already-authorized actor.
 *  - Tenant: the link is found and deleted ONLY with the actor's
 *    organizationId; a link of another organization is "not found".
 *  - Concurrency (P3D-3): inside a SERIALIZABLE transaction, BOTH endpoint
 *    CadDocuments are locked FOR UPDATE in ascending-id order - the same lock
 *    and order a release takes on its closure and createCadDependency takes
 *    on a new edge. So a release either sees the link fully or not at all,
 *    never a torn graph. The caller wraps this in the bounded serialization
 *    retry (final conflict -> CONCURRENT_CHANGES notice).
 *  - Released baselines are NOT affected: they store file versions, not links.
 *  - TRACE (B06-L2, interim until F00 adds real structure history):
 *    CadDependency keeps no history, so each COMMITTED removal emits exactly
 *    one structured log line with actor id, organization id, parent id,
 *    child id, link type and time - ids only, no names, no secrets. It is
 *    emitted AFTER the transaction commits, so a rolled-back or retried
 *    attempt never logs.
 */
import type { PrismaClient, Prisma } from "@/app/generated/prisma/client";
import { ActionRefusalError } from "./action-notice-core.ts";
import { lockCadDocumentForVersionMutation } from "./db-concurrency-db.ts";

/** The slice of PrismaClient this module needs. */
export type RemoveCadDependencyDb = Pick<PrismaClient, "$transaction">;

export interface RemoveCadDependencyActor {
  userId: string;
  organizationId: string;
}

/** The one structured log line written per committed removal. */
export interface CadDependencyRemovedLog {
  event: "cad_dependency_removed";
  actorUserId: string;
  organizationId: string;
  parentDocumentId: string;
  childDocumentId: string;
  dependencyType: string;
  at: string;
}

export const CAD_DEPENDENCY_REMOVED_EVENT = "cad_dependency_removed" as const;

/** Default sink: one JSON line on the server log. */
export function logCadDependencyRemoved(entry: CadDependencyRemovedLog): void {
  console.info(JSON.stringify(entry));
}

/**
 * Remove one CadDependency of the actor's organization, by id.
 *
 * @throws ActionRefusalError("CAD_DEPENDENCY_NOT_FOUND") when there is no
 *   such link in the actor's organization (unknown id, another tenant, or
 *   already removed by someone else). Serialization failures propagate
 *   unchanged for the caller's retry.
 */
export async function removeCadDependencyForActor(
  actor: RemoveCadDependencyActor,
  dependencyId: string,
  db: RemoveCadDependencyDb,
  options: {
    log?: (entry: CadDependencyRemovedLog) => void;
    now?: () => Date;
  } = {},
): Promise<CadDependencyRemovedLog> {
  const removed = await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const edge = await tx.cadDependency.findFirst({
        where: { organizationId: actor.organizationId, id: dependencyId },
        select: {
          id: true,
          parentDocumentId: true,
          childDocumentId: true,
          dependencyType: true,
        },
      });
      if (edge === null) {
        throw new ActionRefusalError("CAD_DEPENDENCY_NOT_FOUND", "That CAD dependency was not found");
      }

      // P3D-3: the same lock, in the same ascending order, as a release and
      // createCadDependency.
      for (const id of [edge.parentDocumentId, edge.childDocumentId].sort()) {
        await lockCadDocumentForVersionMutation(tx, actor.organizationId, id);
      }

      // Tenant-scoped delete by id; 0 rows = removed concurrently.
      const deleted = await tx.cadDependency.deleteMany({
        where: { organizationId: actor.organizationId, id: edge.id },
      });
      if (deleted.count === 0) {
        throw new ActionRefusalError("CAD_DEPENDENCY_NOT_FOUND", "That CAD dependency was not found");
      }

      return edge;
    },
    { isolationLevel: "Serializable" },
  );

  const entry: CadDependencyRemovedLog = {
    event: CAD_DEPENDENCY_REMOVED_EVENT,
    actorUserId: actor.userId,
    organizationId: actor.organizationId,
    parentDocumentId: removed.parentDocumentId,
    childDocumentId: removed.childDocumentId,
    dependencyType: removed.dependencyType,
    at: (options.now ?? (() => new Date()))().toISOString(),
  };
  (options.log ?? logCadDependencyRemoved)(entry);
  return entry;
}
