"use server";

import { revalidatePath } from "next/cache";
import { LifecycleState, UserRole, ItemType } from "@/app/generated/prisma/enums";
import { prisma } from "@/app/lib/prisma";

const DEMO_ORG_CODE = "ARCH";
const terminalLifecycleStates = new Set<LifecycleState>([
  LifecycleState.RELEASED,
  LifecycleState.SUPERSEDED,
  LifecycleState.OBSOLETE,
]);

async function getOrCreateDemoOrganization() {
  const existingOrganization = await prisma.organization.findUnique({
    where: { code: DEMO_ORG_CODE },
  });

  if (existingOrganization) {
    return existingOrganization;
  }

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        code: DEMO_ORG_CODE,
        name: "Arch PLM",
        users: {
          create: [
            {
              email: "mira.engineer@archplm.local",
              name: "Mira Chen",
              role: UserRole.ENGINEER,
            },
            {
              email: "owen.approver@archplm.local",
              name: "Owen Patel",
              role: UserRole.APPROVER,
            },
          ],
        },
      },
    });

    const customer = await tx.customer.create({
      data: {
        organizationId: organization.id,
        name: "Northstar Fabrication",
        customerNumber: "CUST-1001",
      },
    });

    const project = await tx.project.create({
      data: {
        organizationId: organization.id,
        customerId: customer.id,
        projectNumber: "NSF-24-001",
        name: "Modular conveyor platform",
        description: "Released baseline for configurable material handling assemblies.",
      },
    });

    await tx.item.createMany({
      data: [
        {
          organizationId: organization.id,
          projectId: project.id,
          itemNumber: "10073-MFD-AS210",
          description: "Drive frame assembly",
          type: ItemType.ASSEMBLY,
        },
        {
          organizationId: organization.id,
          projectId: project.id,
          itemNumber: "10073-MFD-PL042",
          description: "Side rail plate",
          type: ItemType.PART,
        },
        {
          organizationId: organization.id,
          projectId: project.id,
          itemNumber: "DOC-NSF-INS-001",
          description: "Installation procedure",
          type: ItemType.DOCUMENT,
        },
      ],
    });

    const items = await tx.item.findMany({
      where: { organizationId: organization.id },
      select: { id: true, itemNumber: true },
    });
    const itemIds = Object.fromEntries(items.map((item) => [item.itemNumber, item.id]));

    await tx.itemRevision.createMany({
      data: [
        {
          itemId: itemIds["10073-MFD-AS210"],
          revision: "A",
          description: "Manufacturing release",
          lifecycle: LifecycleState.RELEASED,
          releasedAt: new Date("2026-08-15T14:00:00.000Z"),
        },
        {
          itemId: itemIds["10073-MFD-AS210"],
          revision: "B",
          description: "Bearing mount reinforcement",
          lifecycle: LifecycleState.IN_REVIEW,
        },
        {
          itemId: itemIds["10073-MFD-PL042"],
          revision: "A",
          description: "Initial production part",
          lifecycle: LifecycleState.APPROVED,
        },
        {
          itemId: itemIds["DOC-NSF-INS-001"],
          revision: "A",
          description: "Draft installation work instruction",
        },
      ],
    });

    return organization;
  });
}

function requiredValue(formData: FormData, name: string) {
  const value = formData.get(name);

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
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

export async function createDemoWorkspace() {
  await getOrCreateDemoOrganization();
  revalidatePath("/");
}

export async function createItem(formData: FormData) {
  const organization = await getOrCreateDemoOrganization();
  const projectId = formData.get("projectId");
  const rawRevision = formData.get("revision");
  const revision =
    typeof rawRevision === "string" && rawRevision.trim() !== ""
      ? rawRevision.trim().toUpperCase()
      : "A";

  await prisma.item.create({
    data: {
      organizationId: organization.id,
      projectId: typeof projectId === "string" && projectId !== "" ? projectId : undefined,
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
  const revisionId = requiredValue(formData, "revisionId");
  const lifecycle = enumValue(
    LifecycleState,
    requiredValue(formData, "lifecycle"),
    "lifecycle",
  );
  const currentRevision = await prisma.itemRevision.findUnique({
    where: { id: revisionId },
    select: { lifecycle: true },
  });

  if (!currentRevision) {
    throw new Error("Revision not found");
  }

  if (terminalLifecycleStates.has(currentRevision.lifecycle)) {
    throw new Error("Released or terminal revisions cannot be changed");
  }

  await prisma.itemRevision.update({
    where: { id: revisionId },
    data: {
      lifecycle,
      releasedAt: lifecycle === LifecycleState.RELEASED ? new Date() : null,
    },
  });

  revalidatePath("/");
}
