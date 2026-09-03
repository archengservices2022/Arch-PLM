/*
  Warnings:

  - You are about to drop the column `itemRevisionId` on the `CadDocument` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[organizationId,documentNumber]` on the table `CadDocument` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "CadDocument" DROP CONSTRAINT "CadDocument_organizationId_itemRevisionId_fkey";

-- DropIndex
DROP INDEX "CadDocument_itemRevisionId_idx";

-- DropIndex
DROP INDEX "CadDocument_organizationId_itemRevisionId_documentNumber_key";

-- AlterTable
ALTER TABLE "CadDocument" DROP COLUMN "itemRevisionId";

-- CreateTable
CREATE TABLE "ItemRevisionDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemRevisionId" TEXT NOT NULL,
    "cadDocumentId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemRevisionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemRevisionDocument_organizationId_idx" ON "ItemRevisionDocument"("organizationId");

-- CreateIndex
CREATE INDEX "ItemRevisionDocument_itemRevisionId_idx" ON "ItemRevisionDocument"("itemRevisionId");

-- CreateIndex
CREATE INDEX "ItemRevisionDocument_cadDocumentId_idx" ON "ItemRevisionDocument"("cadDocumentId");

-- CreateIndex
CREATE INDEX "ItemRevisionDocument_createdById_idx" ON "ItemRevisionDocument"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionDocument_organizationId_id_key" ON "ItemRevisionDocument"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionDocument_itemRevisionId_cadDocumentId_key" ON "ItemRevisionDocument"("itemRevisionId", "cadDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "CadDocument_organizationId_documentNumber_key" ON "CadDocument"("organizationId", "documentNumber");

-- AddForeignKey
ALTER TABLE "ItemRevisionDocument" ADD CONSTRAINT "ItemRevisionDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemRevisionDocument" ADD CONSTRAINT "ItemRevisionDocument_organizationId_itemRevisionId_fkey" FOREIGN KEY ("organizationId", "itemRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemRevisionDocument" ADD CONSTRAINT "ItemRevisionDocument_organizationId_cadDocumentId_fkey" FOREIGN KEY ("organizationId", "cadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemRevisionDocument" ADD CONSTRAINT "ItemRevisionDocument_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
