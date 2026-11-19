"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import {
  LifecycleState,
  ItemType,
  CadDocumentType,
  CadDependencyType,
} from "@/app/generated/prisma/enums";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/app/lib/prisma";
import {
  assertCanMutate,
  hasRole,
  PLM_WRITE_ROLES,
  requireActor,
  type Actor,
} from "@/app/lib/authz";
import { getStorageProvider } from "@/app/lib/storage";
import { advanceRevisionForActor } from "@/app/lib/release-db";
import { revalidateLegacyRevisionForActor } from "@/app/lib/legacy-revalidation-db";
import {
  CREATE_NEXT_FROM_HELD_MESSAGE,
  isHeldNonTerminalSource,
} from "@/app/lib/legacy-revalidation-core";
import { lockCadDocumentForVersionMutation } from "@/app/lib/db-concurrency-db";
import { removeCadDependencyForActor } from "@/app/lib/cad-dependency-remove-db";
import {
  ActionRefusalError,
  isUniqueViolationOn,
  noticeHref,
  refuseUnlessCanMutate,
  retryOnSerializationConflict,
  runRefusableNotice,
} from "@/app/lib/action-notice-core";
import {
  canCreateSuccessorFrom,
  isCarryForwardMode,
  isTerminalLifecycle,
  nextRevisionLetter,
  normalizeRevision,
} from "@/app/lib/revisions";

function requiredValue(formData: FormData, name: string) {
  const value = formData.get(name);

  if (typeof value !== "string" || value.trim() === "") {
    throw new ActionRefusalError("FIELD_REQUIRED", `${name} is required`);
  }

  return value.trim();
}

function optionalValue(formData: FormData, name: string) {
  const value = formData.get(name);

  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value.trim();
}

/**
 * Pilot UX fix KI-2: run the part of a Server Action that can be REFUSED.
 *
 * An expected, allowlisted refusal (app/lib/action-notice-core.ts) sends the
 * user to the dashboard with a notice code, so they see a fixed message
 * instead of an error page. Everything else - Next.js control flow first
 * (`unstable_rethrow`), then any unexpected error - is rethrown unchanged.
 *
 * The refusals are all raised before any write or inside a transaction that
 * has already rolled back, so nothing here changes what is written. The
 * redirect happens OUTSIDE the try/catch, as Next.js requires.
 *
 * B06: a refusal that is about one document (a release refused for missing
 * structure) also carries that document's server-side id, so the dashboard
 * can name it (resolved within the user's own organization).
 */
async function runWithRefusalNotice(run: () => Promise<unknown>): Promise<void> {
  const notice = await runRefusableNotice(run, { rethrowFramework: unstable_rethrow });
  if (notice !== null) {
    redirect(noticeHref(notice.code, notice.subject));
  }
}

/**
 * SD-I1: a role that may not mutate (e.g. VIEWER) is sent to the dashboard
 * with the allowlisted `action.ROLE_NOT_PERMITTED` notice instead of an error
 * page (HTTP 500). Runs before any read or write. Each caller keeps
 * assertCanMutate(actor) directly after it as the enforcing check.
 */
async function refuseUnlessWriteRole(actor: Actor): Promise<void> {
  await runWithRefusalNotice(async () => {
    refuseUnlessCanMutate(hasRole(actor, PLM_WRITE_ROLES));
  });
}

/**
 * Narrow a value READ FROM THE DATABASE to an enum. A mismatch here is a data
 * integrity fault, not a user mistake, so it stays a plain Error (error page).
 * Form input uses `formEnumValue` instead.
 */
function enumValue<T extends Record<string, string>>(
  options: T,
  value: string,
  fieldName: string,
): T[keyof T] {
  if (!Object.values(options).includes(value)) {
    throw new Error(`${fieldName} is invalid`);
  }

  return value as T[keyof T];
}

/** Narrow a SUBMITTED form value to an enum; an unknown value is refused with a notice. */
function formEnumValue<T extends Record<string, string>>(
  options: T,
  value: string,
  fieldName: string,
): T[keyof T] {
  if (!Object.values(options).includes(value)) {
    throw new ActionRefusalError("FIELD_INVALID", `${fieldName} is invalid`);
  }

  return value as T[keyof T];
}

/**
 * Run a callback inside a PostgreSQL SERIALIZABLE transaction with a small
 * bounded retry on serialization / write-conflict failures (Prisma P2034).
 *
 * Every attempt re-runs the ENTIRE callback, so any state the callback reads
 * (e.g. an ItemRevision's lifecycle) is read again from a fresh snapshot on
 * retry. Non-P2034 errors (domain errors, other Prisma errors) propagate
 * immediately and are never retried.
 */
async function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  exhaustedMessage: string,
): Promise<T> {
  // FE-M1: the final conflict becomes the CONCURRENT_CHANGES notice (it was
  // previously rethrown raw on the last attempt, i.e. an HTTP 500).
  return retryOnSerializationConflict(
    () =>
      prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    { isConflict: isSerializationError, exhaustedMessage, onExhausted: logRetryExhausted },
  );
}

/** Server-side record of a retry exhaustion; the user only sees the fixed notice. */
function logRetryExhausted(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.warn(`Server Action: serializable retries exhausted (${typeof code === "string" ? code : "unknown"})`);
}

interface LockedItemRevision {
  id: string;
  organizationId: string;
  lifecycle: LifecycleState;
}

/**
 * Take a `SELECT ... FOR UPDATE` row lock on the target ItemRevision inside an
 * open transaction and return its (tenant-scoped) lifecycle.
 *
 * This produces a DETERMINISTIC database row conflict with advanceRevision,
 * whose UPDATE locks the same ItemRevision row:
 *   - if this transaction acquires the lock first, a concurrent release waits
 *     until we commit / roll back;
 *   - if a release owns the row first, this call blocks and then observes the
 *     committed terminal lifecycle (or, under SERIALIZABLE, a P2034 that
 *     runSerializable retries into a fresh snapshot that sees it).
 *
 * Parameterised raw SQL — the `${...}` values are Prisma bind parameters, not
 * string interpolation. Server-only (needs a Prisma transaction client); this
 * helper is not exported and is never reachable from client code.
 *
 * Returns null when the revision is not in the actor's organization.
 */
async function lockItemRevisionForCadMutation(
  tx: Prisma.TransactionClient,
  organizationId: string,
  itemRevisionId: string,
): Promise<LockedItemRevision | null> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; organizationId: string; lifecycle: string }>
  >`
    SELECT "id", "organizationId", "lifecycle"
    FROM "ItemRevision"
    WHERE "id" = ${itemRevisionId}
      AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    // Validate + narrow the raw enum string to LifecycleState without `any`.
    lifecycle: enumValue(LifecycleState, row.lifecycle, "lifecycle"),
  };
}

export async function createItem(formData: FormData) {
  // Tenant + identity come only from the authenticated session.
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  // Form-errors follow-up: user-correctable refusals become a dashboard
  // notice; nothing is written when one occurs.
  await runWithRefusalNotice(async () => {
    // Engineering revisions are single letters A–Z. "a" -> "A"; reject "01"/"BETA"/"A1".
    const rawRevision = optionalValue(formData, "revision");
    let revision = "A";
    if (rawRevision) {
      try {
        revision = normalizeRevision(rawRevision);
      } catch (error) {
        throw new ActionRefusalError(
          "REVISION_LETTER_INVALID",
          error instanceof Error ? error.message : "Revision must be a single letter A–Z.",
        );
      }
    }

    // If a project is supplied, it must belong to the actor's organization.
    const projectId = optionalValue(formData, "projectId");

    if (projectId) {
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          organizationId: actor.organizationId,
        },
        select: { id: true },
      });

      if (!project) {
        throw new ActionRefusalError("PROJECT_NOT_FOUND", "Project not found in your organization");
      }
    }

    const itemNumber = requiredValue(formData, "itemNumber").toUpperCase();
    try {
      await prisma.item.create({
        data: {
          organizationId: actor.organizationId,
          projectId: projectId ?? undefined,
          itemNumber,
          description: requiredValue(formData, "description"),
          type: formEnumValue(ItemType, requiredValue(formData, "type"), "type"),
          revisions: {
            create: {
              revision,
              description: requiredValue(formData, "revisionDescription"),
              // Milestone 3: audit lineage. Initial revision has no source.
              createdById: actor.userId,
            },
          },
        },
      });
    } catch (error) {
      // Only @@unique([organizationId, itemNumber]) means "duplicate item number".
      if (isUniqueViolationOn(error, ["organizationId", "itemNumber"])) {
        throw new ActionRefusalError("ITEM_NUMBER_EXISTS", `Item ${itemNumber} already exists.`);
      }
      throw error;
    }
  });

  revalidatePath("/");
}

/**
 * Move an ItemRevision to a new lifecycle state.
 *
 * The transition map is enforced entirely on the server (see
 * app/lib/revisions.ts). The browser cannot decide whether a transition is
 * legal, and it cannot name which revision gets superseded.
 *
 * CONCURRENCY: the whole thing runs in a SERIALIZABLE transaction (with a
 * bounded P2034 retry), and the transition is ALSO applied with an OPTIMISTIC
 * CONDITIONAL UPDATE — `WHERE ... lifecycle = <the state we validated
 * against>`. If a concurrent request already moved the revision, 0 rows match
 * and we abort instead of applying a transition that was only valid from a
 * now-stale state. Serializable isolation additionally makes this transaction
 * part of the same serializable set as createCadDocument /
 * linkExistingCadDocumentToRevision, so once this transaction commits a
 * terminal lifecycle, no concurrent CAD-association transaction that started
 * from an earlier non-terminal snapshot can commit against it.
 *
 * When a revision transitions to RELEASED, and it was derived from a source
 * revision that is itself currently RELEASED, the source is atomically moved
 * to SUPERSEDED in the SAME transaction — but only if the successor's
 * conditional release actually succeeded. `releasedAt` is set only on the
 * successful RELEASED transition; superseding a source never touches its
 * `releasedAt`.
 *
 * P3D-1: a RELEASED transition ALSO atomically captures a frozen release
 * baseline (the exact FileVersion of every directly associated CadDocument)
 * in the SAME transaction. This thin wrapper only extracts form input and
 * delegates to `app/lib/release-db.ts`'s `advanceRevisionForActor`, which is
 * what the focused tests exercise directly with an in-memory fake database
 * - see that module for the full transition/baseline/concurrency design.
 *
 * B03: approval authority, separation of duties and the append-only
 * lifecycle event are all enforced inside `advanceRevisionForActor`'s
 * transaction (see `app/lib/lifecycle-policy-core.ts`); this wrapper only
 * passes the optional `comment` form field through.
 */
export async function advanceRevision(formData: FormData) {
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  const comment = optionalValue(formData, "comment");

  await runWithRefusalNotice(async () => {
    const revisionId = requiredValue(formData, "revisionId");
    // KI-3: the dashboard no longer pre-selects a state; a submission
    // without an explicit choice is refused with a message.
    const rawTarget = optionalValue(formData, "lifecycle");
    if (rawTarget === undefined) {
      throw new ActionRefusalError("TARGET_STATE_REQUIRED", "lifecycle is required");
    }
    const target = formEnumValue(LifecycleState, rawTarget, "lifecycle");

    await advanceRevisionForActor(actor, revisionId, target, prisma, getStorageProvider(), {
      comment,
    });
  });

  revalidatePath("/");
}

// ============================================================
// PDM Milestone 3: engineering revision + CAD revision-link workflow
//
// "Create next revision" derives Rev B from an APPROVED/RELEASED Rev A:
//   - a NEW ItemRevision (WORKING) is created, with audit lineage
//     (createdById, sourceRevisionId)
//   - the source revision's logical CadDocuments are CARRIED FORWARD by
//     creating new ItemRevisionDocument link rows that point at the SAME
//     existing CadDocument rows
//   - NOTHING is cloned: no CadDocument, no FileVersion, no CadDependency.
//     File-version history and the CadDependency graph are attached to the
//     logical document, so they remain intact and shared automatically.
// ============================================================

function isDuplicateRevisionError(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target: unknown = error.meta?.target;
  if (Array.isArray(target)) {
    const fields = target.filter(
      (field): field is string => typeof field === "string",
    );
    return fields.includes("itemId") && fields.includes("revision");
  }
  if (typeof target === "string") {
    return target.includes("itemId") && target.includes("revision");
  }
  return false;
}

/**
 * Create the next engineering revision (A->B, B->C, ...) from an eligible
 * source revision, carrying forward its CAD document links.
 *
 * Server rules:
 *  - sourceRevisionId comes from the form; the source revision and its Item
 *    must belong to the actor's organization.
 *  - The source must be APPROVED or RELEASED (WORKING / IN_REVIEW / OBSOLETE /
 *    SUPERSEDED are rejected).
 *  - The new revision letter is DERIVED server-side from the source; any
 *    submitted "revision" field is ignored.
 *  - carryForwardMode is EXPLICIT ("all" | "selected" | "none"); it is never
 *    inferred from the presence/absence of checkbox values. In "selected"
 *    mode every submitted id must actually be linked to the source revision
 *    and belong to the actor's organization.
 *  - description: the trimmed user value if non-empty, otherwise the source
 *    revision's description is copied forward.
 *  - organizationId / createdById always come from the session.
 *  - The new revision + all carry-forward links are one atomic transaction.
 *  - A concurrent duplicate is caught via @@unique([itemId, revision]) -> P2002
 *    and reported as a clear domain error.
 */
export async function createEngineeringRevision(formData: FormData) {
  const actor = await requireActor();
  // F-1: a direct request from a role that may not create revisions (e.g.
  // VIEWER) gets a typed, allowlisted notice instead of an error page. Same
  // rule as assertCanMutate, which stays below as the enforcing check.
  await runWithRefusalNotice(async () => {
    if (!hasRole(actor, PLM_WRITE_ROLES)) {
      throw new ActionRefusalError(
        "CREATE_NEXT_ROLE_NOT_PERMITTED",
        "You do not have permission to perform this action.",
      );
    }
  });
  assertCanMutate(actor);

  // KI-2 + form-errors follow-up: the expected refusals below (form input
  // included) are ActionRefusalErrors (same server messages as before); they
  // roll the transaction back and are shown as a notice.
  await runWithRefusalNotice(async () => {
    const sourceRevisionId = requiredValue(formData, "sourceRevisionId");

    // Explicit carry-forward mode. Default "all"; unknown values are rejected.
    const carryForwardMode = optionalValue(formData, "carryForwardMode") ?? "all";
    if (!isCarryForwardMode(carryForwardMode)) {
      throw new ActionRefusalError("FIELD_INVALID", `Unknown carry-forward mode: "${carryForwardMode}"`);
    }

    // Submitted document ids (only meaningful in "selected" mode).
    const selectedDocumentIds = new Set<string>();
    for (const value of formData.getAll("carryForwardDocumentId")) {
      if (typeof value === "string" && value.trim() !== "") {
        selectedDocumentIds.add(value.trim());
      }
    }
    const csv = optionalValue(formData, "carryForwardDocumentIds");
    if (csv) {
      for (const part of csv.split(",")) {
        if (part.trim() !== "") selectedDocumentIds.add(part.trim());
      }
    }

    const providedDescription = optionalValue(formData, "description");

    await prisma.$transaction(async (tx) => {
      // 1-2. Source revision + its Item must be in the actor's organization.
      const source = await tx.itemRevision.findFirst({
        where: { id: sourceRevisionId, organizationId: actor.organizationId },
        select: {
          id: true,
          itemId: true,
          revision: true,
          lifecycle: true,
          description: true,
          item: { select: { organizationId: true } },
          documentLinks: { select: { cadDocumentId: true } },
          legacyLifecycleHold: { select: { itemRevisionId: true } },
        },
      });

      if (!source || source.item.organizationId !== actor.organizationId) {
        throw new ActionRefusalError(
          "CREATE_NEXT_SOURCE_NOT_FOUND",
          "Source revision not found in your organization",
        );
      }

      // Option A: a held, non-terminal legacy revision (in practice a held
      // APPROVED one) may only be continued through "Revalidate as new
      // revision", which closes it, records the reason and applies the O-2
      // exclusions. Held RELEASED/SUPERSEDED/OBSOLETE sources are unaffected.
      if (
        isHeldNonTerminalSource({
          lifecycle: source.lifecycle,
          legacyHold: source.legacyLifecycleHold !== null,
        })
      ) {
        throw new ActionRefusalError("CREATE_NEXT_HELD_SOURCE", CREATE_NEXT_FROM_HELD_MESSAGE);
      }

      // 9. Eligibility: only APPROVED / RELEASED sources.
      if (!canCreateSuccessorFrom(source.lifecycle)) {
        throw new ActionRefusalError(
          "CREATE_NEXT_NOT_ELIGIBLE",
          `A successor revision can only be created from an APPROVED or RELEASED revision (this revision is ${source.lifecycle}).`,
        );
      }

      // 6 + 10. Next revision letter is derived on the server. Revision Z has
      // no successor yet (same message nextRevisionLetter has always used).
      if (source.revision.trim().toUpperCase() === "Z") {
        throw new ActionRefusalError(
          "CREATE_NEXT_REVISION_LIMIT",
          "Revisions beyond Z are not supported yet.",
        );
      }
      const newRevision = nextRevisionLetter(source.revision);

      // 7. Reject an existing revision for the same Item (fast path; the unique
      // constraint below is the real guard against races).
      const clash = await tx.itemRevision.findFirst({
        where: { itemId: source.itemId, revision: newRevision },
        select: { id: true },
      });
      if (clash) {
        throw new ActionRefusalError(
          "CREATE_NEXT_REVISION_EXISTS",
          `Revision ${newRevision} already exists for this item.`,
        );
      }

      // 5. Resolve carry-forward set from the EXPLICIT mode.
      const sourceDocumentIds = source.documentLinks.map(
        (link) => link.cadDocumentId,
      );
      let carryForwardIds: string[];
      if (carryForwardMode === "none") {
        carryForwardIds = [];
      } else if (carryForwardMode === "all") {
        carryForwardIds = sourceDocumentIds;
      } else {
        // "selected": carry only the submitted ids, each of which must be
        // linked to the source revision.
        for (const id of selectedDocumentIds) {
          if (!sourceDocumentIds.includes(id)) {
            throw new ActionRefusalError(
              "CAD_DOCUMENT_NOT_ON_SOURCE",
              "A selected CAD document is not linked to the source revision.",
            );
          }
        }
        carryForwardIds = [...selectedDocumentIds];
      }

      // Defense in depth: every carry-forward document is in the actor's org.
      if (carryForwardIds.length > 0) {
        const owned = await tx.cadDocument.findMany({
          where: {
            id: { in: carryForwardIds },
            organizationId: actor.organizationId,
          },
          select: { id: true },
        });
        if (owned.length !== carryForwardIds.length) {
          throw new ActionRefusalError(
            "CAD_DOCUMENT_NOT_FOUND",
            "A selected CAD document was not found in your organization.",
          );
        }
      }

      // 8-10. Create the new revision (WORKING) with lineage.
      let created;
      try {
        created = await tx.itemRevision.create({
          data: {
            organizationId: actor.organizationId,
            itemId: source.itemId,
            revision: newRevision,
            lifecycle: LifecycleState.WORKING,
            // description: user's value if non-empty, else carry the source's.
            description: providedDescription ?? source.description,
            createdById: actor.userId,
            sourceRevisionId: source.id,
          },
          select: { id: true, revision: true },
        });
      } catch (error) {
        if (isDuplicateRevisionError(error)) {
          throw new ActionRefusalError(
            "CREATE_NEXT_REVISION_EXISTS",
            `Revision ${newRevision} already exists for this item.`,
          );
        }
        throw error;
      }

      // 5 + 15. Carry forward the SAME logical CadDocuments (no cloning).
      if (carryForwardIds.length > 0) {
        await tx.itemRevisionDocument.createMany({
          data: carryForwardIds.map((cadDocumentId) => ({
            organizationId: actor.organizationId,
            itemRevisionId: created.id,
            cadDocumentId,
            createdById: actor.userId,
          })),
        });
      }
    });
  });

  revalidatePath("/");
}

/**
 * Option A: revalidate a held legacy revision into a fresh successor revision.
 *
 * Thin wrapper: every rule (eligibility, O-3 roles, closure, successor letter
 * and Z limit, carry-forward, O-5 required reason, audit link, idempotency)
 * is enforced inside `revalidateLegacyRevisionForActor`'s SERIALIZABLE
 * transaction (app/lib/legacy-revalidation-db.ts). Carry-forward fields use
 * the same names as "Create next revision".
 */
export async function revalidateLegacyRevision(formData: FormData) {
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  const carryForward = optionalValue(formData, "carryForwardMode") ?? "all";
  const selected: string[] = [];
  for (const value of formData.getAll("carryForwardDocumentId")) {
    if (typeof value === "string" && value.trim() !== "") selected.push(value.trim());
  }

  // KI-2: expected refusals (reason required, revision Z, role, missing
  // legacy revision id, ...) are shown as a notice; nothing is written.
  await runWithRefusalNotice(() =>
    revalidateLegacyRevisionForActor(
      actor,
      requiredValue(formData, "legacyRevisionId"),
      {
        carryForward,
        selectedCadDocumentIds: selected,
        description: optionalValue(formData, "description") ?? null,
        comment: formData.get("reason") ?? undefined,
      },
      prisma,
    ),
  );

  revalidatePath("/");
}

/**
 * Link an already-existing CadDocument to an existing ItemRevision in the same
 * organization. Useful when a document created against one revision needs to be
 * associated with another later revision without going through
 * "Create next revision".
 *
 * Tenant-safe: revision and document must both belong to the actor's
 * organization (application check + composite FKs). Duplicate links are a
 * no-op (idempotent). organizationId / createdById come from the session.
 *
 * CONCURRENCY (strict): inside ONE SERIALIZABLE transaction (bounded P2034
 * retry) the target ItemRevision row is locked with SELECT ... FOR UPDATE
 * BEFORE the lifecycle is validated or the link is written, giving a
 * deterministic row-lock conflict with advanceRevision (which updates the
 * same row). If a release owns the row first, this action waits and then
 * observes the committed terminal lifecycle and is rejected.
 */
export async function linkExistingCadDocumentToRevision(formData: FormData) {
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  // Form-errors follow-up: refusals become a notice; the transaction has
  // rolled back (or nothing was started) when one occurs.
  await runWithRefusalNotice(async () => {
    const itemRevisionId = requiredValue(formData, "itemRevisionId");
    const cadDocumentId = requiredValue(formData, "cadDocumentId");

    try {
      await runSerializable(async (tx) => {
        // 1. Lock the target ItemRevision row (tenant-scoped) FOR UPDATE.
        const revision = await lockItemRevisionForCadMutation(
          tx,
          actor.organizationId,
          itemRevisionId,
        );
        if (!revision) {
          throw new ActionRefusalError(
            "ITEM_REVISION_NOT_FOUND",
            "Item revision not found in your organization",
          );
        }

        // 2. Validate lifecycle from the LOCKED row.
        if (isTerminalLifecycle(revision.lifecycle)) {
          throw new ActionRefusalError(
            "REVISION_TERMINAL_FOR_CAD",
            "CAD documents cannot be linked to a released or terminal revision.",
          );
        }

        // 3. Validate the existing CadDocument belongs to the actor's org.
        const document = await tx.cadDocument.findFirst({
          where: { id: cadDocumentId, organizationId: actor.organizationId },
          select: { id: true },
        });
        if (!document) {
          throw new ActionRefusalError(
            "CAD_DOCUMENT_NOT_FOUND",
            "CAD document not found in your organization",
          );
        }

        // 4. Only now — still holding the row lock — create the link.
        await tx.itemRevisionDocument.create({
          data: {
            organizationId: actor.organizationId,
            itemRevisionId: revision.id,
            cadDocumentId: document.id,
            createdById: actor.userId,
          },
        });
      }, "Could not link the CAD document due to concurrent changes, please retry");
    } catch (error) {
      // FE-L1: only @@unique([itemRevisionId, cadDocumentId]) means "already
      // linked" (idempotent success); any other P2002 propagates unchanged.
      if (isUniqueViolationOn(error, ["itemRevisionId", "cadDocumentId"])) {
        return;
      }
      throw error;
    }
  });

  revalidatePath("/");
}

// ============================================================
// PDM: CAD documents and file versions
//
// ITEM != ENGINEERING REVISION != CAD DOCUMENT != FILE VERSION
//
// These actions never read, write, or create ItemRevision.revision
// or ItemRevision.lifecycle. Adding CAD file versions is completely
// independent of the engineering revision lifecycle.
//
// TODO(release-snapshot): a logical CadDocument can keep receiving
// FileVersions AFTER an older ItemRevision that references it has been
// RELEASED. So a released revision's "latest CAD version" is NOT a frozen
// release baseline today — it tracks the live document. Before Arch PLM can
// claim strict released CAD baselines it needs a release-snapshot / version-
// pinning model (e.g. capture the exact FileVersion id per CadDocument at
// the moment a revision is RELEASED). That model is intentionally not built
// here and does not change the current FileVersion architecture.
// ============================================================

/**
 * Create a new CAD document identity (owned by the organization) and link it
 * to the selected ItemRevision through ItemRevisionDocument.
 *
 * Does NOT create a file version and does NOT touch the engineering revision.
 *
 * CONCURRENCY (strict): inside ONE SERIALIZABLE transaction (bounded P2034
 * retry) the target ItemRevision row is locked with SELECT ... FOR UPDATE
 * BEFORE the lifecycle is validated or anything is written. advanceRevision
 * updates the same row, so the two operations take a deterministic row-lock
 * conflict:
 *   - if this action holds the lock, a concurrent release waits for our commit;
 *   - if a release holds the row first, this action waits and then sees the
 *     committed terminal lifecycle and is rejected.
 * The CadDocument insert is in the SAME transaction, so any failure rolls it
 * back — no orphan CadDocument.
 */
export async function createCadDocument(formData: FormData) {
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  // Form-errors follow-up: refusals become a notice; the transaction has
  // rolled back (or nothing was started) when one occurs.
  await runWithRefusalNotice(async () => {
    const itemRevisionId = requiredValue(formData, "itemRevisionId");
    const fileName = requiredValue(formData, "fileName");
    const documentNumber = optionalValue(formData, "documentNumber") ?? fileName;
    const documentType = formEnumValue(
      CadDocumentType,
      requiredValue(formData, "documentType"),
      "documentType",
    );
    const description = optionalValue(formData, "description");

    try {
      await runSerializable(async (tx) => {
        // 1. Lock the target ItemRevision row (tenant-scoped) FOR UPDATE.
        const revision = await lockItemRevisionForCadMutation(
          tx,
          actor.organizationId,
          itemRevisionId,
        );

        if (!revision) {
          throw new ActionRefusalError(
            "ITEM_REVISION_NOT_FOUND",
            "Item revision not found in your organization",
          );
        }

        // 2. Validate lifecycle from the LOCKED row. A RELEASED / SUPERSEDED /
        //    OBSOLETE revision is immutable: its CAD associations cannot change.
        if (isTerminalLifecycle(revision.lifecycle)) {
          throw new ActionRefusalError(
            "REVISION_TERMINAL_FOR_CAD",
            "CAD documents cannot be added to a released or terminal revision.",
          );
        }

        // 3. Only now — still holding the row lock — create the document + link.
        const cadDocument = await tx.cadDocument.create({
          data: {
            organizationId: actor.organizationId,
            documentNumber,
            fileName,
            documentType,
            description,
            // Identity comes only from the authenticated actor.
            createdById: actor.userId,
          },
          select: { id: true },
        });

        await tx.itemRevisionDocument.create({
          data: {
            organizationId: actor.organizationId,
            itemRevisionId: revision.id,
            cadDocumentId: cadDocument.id,
            createdById: actor.userId,
          },
        });
      }, "Could not add the CAD document due to concurrent changes, please retry");
    } catch (error) {
      // Only @@unique([organizationId, documentNumber, documentType]) means
      // "duplicate CAD document"; any other P2002 propagates unchanged.
      if (isUniqueViolationOn(error, ["organizationId", "documentNumber", "documentType"])) {
        throw new ActionRefusalError(
          "CAD_DOCUMENT_EXISTS",
          `CAD document ${documentNumber} (${documentType}) already exists.`,
        );
      }
      throw error;
    }
  });

  revalidatePath("/");
}

// FileVersion rows are created only by the storage upload path
// (app/lib/storage.ts + app/api/cad-documents/[cadDocumentId]/file-versions).
// Every FileVersion represents real, immutable, checksum-verified stored
// bytes - there is no metadata-only / synthetic-storage-key creation path.
// Creating a file version still never creates or mutates an ItemRevision.

// ============================================================
// PDM Milestone 2: CAD dependency / reference graph
//
// ARCHITECTURAL DECISION: dependencies link logical CAD DOCUMENTS,
// never individual FileVersions. "Assembly.iam uses Part.ipt" is a
// stable logical fact that survives every file version bump. A
// version-pinned dependency snapshot taken at check-in / release is
// a separate future milestone and is NOT implemented here.
// ============================================================

// Defensive bound: the largest number of distinct documents the cycle
// check will traverse before refusing to continue. Manual test graphs
// are tiny; this only exists so malformed / adversarial data cannot
// spin the traversal forever.
const CAD_GRAPH_TRAVERSAL_LIMIT = 2000;

/**
 * Would adding the edge `parentDocumentId -> childDocumentId` create a cycle?
 *
 * A cycle appears iff `parentDocumentId` is already reachable FROM
 * `childDocumentId` by following existing parent -> child edges
 * (i.e. a path child ->* parent already exists).
 *
 * Breadth-first, tenant-scoped, with a visited set (so pre-existing
 * malformed cycles cannot loop) and a hard node cap.
 *
 * NOTE: this only prevents NEW edges from closing a cycle. Detecting and
 * repairing pre-existing malformed / cyclic graphs (e.g. imported by a
 * future Inventor add-in or created before this guard existed) is out of
 * scope here and belongs in a later administrative "graph integrity check"
 * feature. TODO(pdm-admin): dependency graph integrity audit + repair tool.
 */
async function edgeWouldCreateCycle(
  db: Prisma.TransactionClient,
  organizationId: string,
  parentDocumentId: string,
  childDocumentId: string,
): Promise<boolean> {
  if (parentDocumentId === childDocumentId) {
    return true;
  }

  const visited = new Set<string>([childDocumentId]);
  let frontier: string[] = [childDocumentId];

  while (frontier.length > 0) {
    const edges = await db.cadDependency.findMany({
      where: {
        organizationId,
        parentDocumentId: { in: frontier },
      },
      select: { childDocumentId: true },
    });

    const next: string[] = [];

    for (const edge of edges) {
      if (edge.childDocumentId === parentDocumentId) {
        // child ->* parent path exists; the new parent -> child edge closes it.
        return true;
      }

      if (!visited.has(edge.childDocumentId)) {
        visited.add(edge.childDocumentId);
        next.push(edge.childDocumentId);

        if (visited.size > CAD_GRAPH_TRAVERSAL_LIMIT) {
          throw new ActionRefusalError(
            "CAD_GRAPH_TOO_LARGE",
            "The CAD reference graph is too large to validate safely. " +
              "Please contact an administrator.",
          );
        }
      }
    }

    frontier = next;
  }

  return false;
}

/**
 * Manually record a directional CAD dependency:
 *   parentDocument --(dependencyType)--> childDocument
 *
 * - Authenticated, active, non-viewer actor only.
 * - organizationId and createdById come from the session, never FormData.
 * - Both documents must belong to the actor's organization.
 * - Self-references are rejected.
 * - The edge is rejected if it would create a cycle in the existing graph.
 * - Only a duplicate of the parent+child+type edge unique constraint is
 *   translated to a friendly message; any other P2002 propagates as-is.
 *
 * The document lookup, cycle check and insert run in one Serializable
 * transaction so two concurrent writers cannot each pass the cycle check
 * and then jointly form a cycle.
 */
export async function createCadDependency(formData: FormData) {
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  // Form-errors follow-up: refusals become a notice; each transaction attempt
  // has rolled back when one occurs. Success revalidates inside the loop.
  await runWithRefusalNotice(async () => {
    const parentDocumentId = requiredValue(formData, "parentDocumentId");
    const childDocumentId = requiredValue(formData, "childDocumentId");
    const dependencyType = formEnumValue(
      CadDependencyType,
      requiredValue(formData, "dependencyType"),
      "dependencyType",
    );

    if (parentDocumentId === childDocumentId) {
      throw new ActionRefusalError("CAD_SELF_DEPENDENCY", "A CAD document cannot depend on itself");
    }

    // FE-M1: bounded retry; the final serialization conflict becomes the
    // CONCURRENT_CHANGES notice instead of a raw P2034 (HTTP 500).
    await retryOnSerializationConflict(async () => {
      try {
        await prisma.$transaction(
          async (tx) => {
            // Both endpoints must exist inside the actor's organization.
            // (The composite FKs are a second, database-level guard.)
            const documents = await tx.cadDocument.findMany({
              where: {
                organizationId: actor.organizationId,
                id: { in: [parentDocumentId, childDocumentId] },
              },
              select: { id: true },
            });
            const foundIds = new Set(documents.map((document) => document.id));

            if (
              !foundIds.has(parentDocumentId) ||
              !foundIds.has(childDocumentId)
            ) {
              throw new ActionRefusalError(
                "CAD_DOCUMENT_NOT_FOUND",
                "Both CAD documents must exist in your organization",
              );
            }

            // P3D-3: serialize this edge write against a release freezing its
            // dependency closure. A release locks EVERY closure CadDocument
            // row (`lockCadDocumentForVersionMutation`) in ascending-id order;
            // taking the SAME lock on this edge's endpoints, in the SAME
            // order, means a release either sees this edge fully (it committed
            // first) or cannot start freezing until this commits - never a
            // torn graph. Sorted order also prevents an AB/BA deadlock against
            // a release or another concurrent dependency write.
            for (const id of [parentDocumentId, childDocumentId].sort()) {
              await lockCadDocumentForVersionMutation(
                tx,
                actor.organizationId,
                id,
              );
            }

            if (
              await edgeWouldCreateCycle(
                tx,
                actor.organizationId,
                parentDocumentId,
                childDocumentId,
              )
            ) {
              throw new ActionRefusalError(
                "CAD_DEPENDENCY_CYCLE",
                "That dependency would create a circular reference in the CAD graph",
              );
            }

            await tx.cadDependency.create({
              data: {
                organizationId: actor.organizationId,
                parentDocumentId,
                childDocumentId,
                dependencyType,
                createdById: actor.userId,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

      } catch (error) {
        // Only the parent+child+type edge-uniqueness constraint means
        // "duplicate edge". Any other P2002 (e.g. the [organizationId, id]
        // constraint) is unexpected and must not be masked. A serialization
        // failure is rethrown unchanged so the retry helper can retry it.
        if (isDuplicateDependencyEdgeError(error)) {
          throw new ActionRefusalError("CAD_DEPENDENCY_EXISTS", "That CAD dependency already exists");
        }
        throw error;
      }
    }, {
      isConflict: isSerializationError,
      exhaustedMessage: "Could not record the CAD dependency due to concurrent changes, please retry",
      onExhausted: logRetryExhausted,
    });
  });

  revalidatePath("/");
}

/**
 * B06 G-3: remove a CAD structure link (PO-signed B06 plan Rev1, G-3(a)).
 * Write roles only, tenant-scoped, serialized against a release with the
 * same sorted two-endpoint lock as createCadDependency, bounded retry
 * (final conflict -> CONCURRENT_CHANGES). Each committed removal writes one
 * structured server log line (interim trace until F00). See
 * app/lib/cad-dependency-remove-db.ts.
 */
export async function removeCadDependency(formData: FormData) {
  const actor = await requireActor();
  await refuseUnlessWriteRole(actor); // SD-I1: typed notice instead of HTTP 500
  assertCanMutate(actor);

  await runWithRefusalNotice(async () => {
    const dependencyId = requiredValue(formData, "dependencyId");
    await retryOnSerializationConflict(
      () => removeCadDependencyForActor(actor, dependencyId, prisma),
      {
        isConflict: isSerializationError,
        exhaustedMessage: "Could not remove the CAD dependency due to concurrent changes, please retry",
        onExhausted: logRetryExhausted,
      },
    );
  });

  revalidatePath("/");
}

function isSerializationError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  // Write conflict / deadlock reported directly by Prisma.
  if (error.code === "P2034") {
    return true;
  }

  // A raw query (e.g. `SELECT ... FOR UPDATE` in lockItemRevisionForCadMutation)
  // can surface the PostgreSQL SQLSTATE through P2010 instead of P2034.
  //   40001 = serialization_failure, 40P01 = deadlock_detected
  if (error.code === "P2010") {
    const meta: unknown = error.meta;
    const pgCode =
      meta && typeof meta === "object" && "code" in meta
        ? (meta as { code: unknown }).code
        : undefined;
    return pgCode === "40001" || pgCode === "40P01";
  }

  return false;
}

// Postgres truncates the generated index name to 63 chars.
const CAD_DEPENDENCY_EDGE_UNIQUE_CONSTRAINT =
  "CadDependency_organizationId_parentDocumentId_childDocument_key";

/**
 * True only when a P2002 was raised by the CadDependency edge-uniqueness
 * constraint (organizationId, parentDocumentId, childDocumentId, dependencyType).
 * `error.meta.target` is `unknown` per Prisma's types, so it is narrowed by hand
 * and may be either a field-name list or the constraint name string.
 */
function isDuplicateDependencyEdgeError(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target: unknown = error.meta?.target;

  if (Array.isArray(target)) {
    const fields = target.filter(
      (field): field is string => typeof field === "string",
    );
    return (
      fields.includes("parentDocumentId") &&
      fields.includes("childDocumentId") &&
      fields.includes("dependencyType")
    );
  }

  if (typeof target === "string") {
    return (
      target === CAD_DEPENDENCY_EDGE_UNIQUE_CONSTRAINT ||
      (target.includes("parentDocumentId") &&
        target.includes("childDocumentId"))
    );
  }

  return false;
}
