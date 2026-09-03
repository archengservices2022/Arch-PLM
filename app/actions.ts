"use server";

import { revalidatePath } from "next/cache";
import { LifecycleState, ItemType } from "@/app/generated/prisma/enums";
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
