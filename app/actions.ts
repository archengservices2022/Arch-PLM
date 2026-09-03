"use server";

import { revalidatePath } from "next/cache";
import {
  LifecycleState,
  ItemType,
  CadDocumentType,
} from "@/app/generated/prisma/enums";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/app/lib/prisma";
import { assertCanMutate, requireActor } from "@/app/lib/authz";

const terminalLifecycleStates = new Set<LifecycleState>([
  LifecycleState.RELEASED,
  LifecycleState.SUPERSEDED,
  LifecycleState.OBSOLETE,
]);

function requiredValue(formData: FormData, name: string) {
  const value = formData.get(name);

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
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

export async function createItem(formData: FormData) {
  // Tenant + identity come only from the authenticated session.
  const actor = await requireActor();
  assertCanMutate(actor);

  const rawRevision = optionalValue(formData, "revision");
  const revision =
    rawRevision && rawRevision !== "" ? rawRevision.toUpperCase() : "A";

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
      throw new Error("Project not found in your organization");
    }
  }

  await prisma.item.create({
    data: {
      organizationId: actor.organizationId,
      projectId: projectId ?? undefined,
      itemNumber: requiredValue(formData, "itemNumber").toUpperCase(),
      description: requiredValue(formData, "description"),
      type: enumValue(ItemType, requiredValue(formData, "type"), "type"),
      revisions: {
        create: {
          revision,
          description: requiredValue(formData, "revisionDescription"),
        },
      },
    },
  });

  revalidatePath("/");
}

export async function advanceRevision(formData: FormData) {
  const actor = await requireActor();
  assertCanMutate(actor);

  const revisionId = requiredValue(formData, "revisionId");
  const lifecycle = enumValue(
    LifecycleState,
    requiredValue(formData, "lifecycle"),
    "lifecycle",
  );

  // Only revisions whose Item belongs to the actor's organization are visible.
  const currentRevision = await prisma.itemRevision.findFirst({
    where: {
      id: revisionId,
      item: { organizationId: actor.organizationId },
    },
    select: { lifecycle: true },
  });

  if (!currentRevision) {
    throw new Error("Revision not found");
  }

  // Lifecycle protection: terminal / released revisions stay locked.
  if (terminalLifecycleStates.has(currentRevision.lifecycle)) {
    throw new Error("Released or terminal revisions cannot be changed");
  }

  await prisma.itemRevision.updateMany({
    where: {
      id: revisionId,
      item: { organizationId: actor.organizationId },
    },
    data: {
      lifecycle,
      releasedAt: lifecycle === LifecycleState.RELEASED ? new Date() : null,
    },
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
// ============================================================

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Create a new CAD document identity (owned by the organization) and link it
 * to the selected ItemRevision through ItemRevisionDocument.
 *
 * The document and the revision link are created atomically in one transaction.
 * Does NOT create a file version and does NOT touch the engineering revision.
 */
export async function createCadDocument(formData: FormData) {
  const actor = await requireActor();
  assertCanMutate(actor);

  const itemRevisionId = requiredValue(formData, "itemRevisionId");
  const fileName = requiredValue(formData, "fileName");
  const documentNumber = optionalValue(formData, "documentNumber") ?? fileName;
  const documentType = enumValue(
    CadDocumentType,
    requiredValue(formData, "documentType"),
    "documentType",
  );
  const description = optionalValue(formData, "description");

  // The target ItemRevision must belong to the actor's organization.
  // (The composite FKs below are a second, database-level guard.)
  const itemRevision = await prisma.itemRevision.findFirst({
    where: {
      id: itemRevisionId,
      organizationId: actor.organizationId,
    },
    select: { id: true },
  });

  if (!itemRevision) {
    throw new Error("Item revision not found in your organization");
  }

  await prisma.$transaction(async (tx) => {
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
        itemRevisionId: itemRevision.id,
        cadDocumentId: cadDocument.id,
        createdById: actor.userId,
      },
    });
  });

  revalidatePath("/");
}

/**
 * Record a new physical file version (V1, V2, V3 ...) for a CAD document.
 *
 * The version number is allocated on the server. `versionNumber` from the
 * browser is ignored. Creating V2/V3 does not alter or create any
 * ItemRevision.
 */
export async function createFileVersion(formData: FormData) {
  const actor = await requireActor();
  assertCanMutate(actor);

  const cadDocumentId = requiredValue(formData, "cadDocumentId");
  const providedFileName = optionalValue(formData, "originalFileName");

  // The parent CadDocument must belong to the actor's organization.
  const cadDocument = await prisma.cadDocument.findFirst({
    where: {
      id: cadDocumentId,
      organizationId: actor.organizationId,
    },
    select: { id: true, fileName: true },
  });

  if (!cadDocument) {
    throw new Error("CAD document not found in your organization");
  }

  const originalFileName = providedFileName ?? cadDocument.fileName;

  // Concurrency-safe sequencing:
  //   next = MAX(versionNumber) + 1, then INSERT.
  // The @@unique([cadDocumentId, versionNumber]) constraint is the source of
  // truth: if two requests race, the loser hits P2002 and simply recomputes.
  const MAX_ATTEMPTS = 5;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const latest = await prisma.fileVersion.findFirst({
      where: {
        cadDocumentId: cadDocument.id,
        organizationId: actor.organizationId,
      },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });

    const nextVersion = (latest?.versionNumber ?? 0) + 1;

    // storageKey is metadata only for this milestone. No file is stored.
    const storageKey = `organizations/${actor.organizationId}/documents/${cadDocument.id}/versions/${nextVersion}/${originalFileName}`;

    try {
      await prisma.fileVersion.create({
        data: {
          organizationId: actor.organizationId,
          cadDocumentId: cadDocument.id,
          versionNumber: nextVersion,
          originalFileName,
          storageKey,
          createdById: actor.userId,
        },
      });

      revalidatePath("/");
      return;
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < MAX_ATTEMPTS) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    "Could not allocate a file version number after multiple attempts, please retry",
  );
}
