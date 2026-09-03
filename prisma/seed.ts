import bcrypt from "bcryptjs";

import { prisma } from "../app/lib/prisma";

async function main() {
  const adminEmail = process.env.ARCH_PLM_ADMIN_EMAIL;
  const adminPassword = process.env.ARCH_PLM_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    throw new Error(
      "ARCH_PLM_ADMIN_EMAIL and ARCH_PLM_ADMIN_PASSWORD must be set."
    );
  }

  if (adminPassword.length < 12) {
    throw new Error("Admin password must be at least 12 characters.");
  }

  const organization = await prisma.organization.upsert({
    where: {
      code: "ARCH",
    },

    update: {
      name: "Arch Engineering Services",
    },

    create: {
      name: "Arch Engineering Services",
      code: "ARCH",
    },
  });

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const existingUser = await prisma.user.findFirst({
    where: {
      organizationId: organization.id,
      email: {
        equals: adminEmail.trim().toLowerCase(),
        mode: "insensitive",
      },
    },
  });

  if (existingUser) {
    await prisma.user.update({
      where: {
        id: existingUser.id,
      },

      data: {
        name: "Arch PLM Administrator",
        email: adminEmail.trim().toLowerCase(),
        passwordHash,
        role: "ADMIN",
        active: true,
      },
    });

    console.log("Arch PLM administrator updated.");
  } else {
    await prisma.user.create({
      data: {
        organizationId: organization.id,
        name: "Arch PLM Administrator",
        email: adminEmail.trim().toLowerCase(),
        passwordHash,
        role: "ADMIN",
        active: true,
      },
    });

    console.log("Arch PLM administrator created.");
  }

  console.log(`Organization: ${organization.name}`);
  console.log(`Organization code: ${organization.code}`);
  console.log(`Administrator: ${adminEmail.trim().toLowerCase()}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });