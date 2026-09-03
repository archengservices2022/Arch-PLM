-- CreateEnum
CREATE TYPE "CadDocumentType" AS ENUM ('IPT', 'IAM', 'IDW', 'DWG', 'PDF', 'OTHER');

-- DropForeignKey
ALTER TABLE "ItemRevision" DROP CONSTRAINT "ItemRevision_itemId_fkey";

-- AlterTable
ALTER TABLE "ItemRevision" ADD COLUMN     "organizationId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "CadDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemRevisionId" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "documentType" "CadDocumentType" NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CadDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cadDocumentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileSize" BIGINT,
    "checksum" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CadDocument_organizationId_idx" ON "CadDocument"("organizationId");

-- CreateIndex
CREATE INDEX "CadDocument_itemRevisionId_idx" ON "CadDocument"("itemRevisionId");

-- CreateIndex
CREATE INDEX "CadDocument_createdById_idx" ON "CadDocument"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "CadDocument_organizationId_id_key" ON "CadDocument"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CadDocument_organizationId_itemRevisionId_documentNumber_key" ON "CadDocument"("organizationId", "itemRevisionId", "documentNumber");

-- CreateIndex
CREATE INDEX "FileVersion_organizationId_idx" ON "FileVersion"("organizationId");

-- CreateIndex
CREATE INDEX "FileVersion_cadDocumentId_idx" ON "FileVersion"("cadDocumentId");

-- CreateIndex
CREATE INDEX "FileVersion_createdById_idx" ON "FileVersion"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_cadDocumentId_versionNumber_key" ON "FileVersion"("cadDocumentId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_organizationId_id_key" ON "FileVersion"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ItemRevision_organizationId_idx" ON "ItemRevision"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevision_organizationId_id_key" ON "ItemRevision"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_id_key" ON "User"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "ItemRevision" ADD CONSTRAINT "ItemRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemRevision" ADD CONSTRAINT "ItemRevision_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "Item"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadDocument" ADD CONSTRAINT "CadDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadDocument" ADD CONSTRAINT "CadDocument_organizationId_itemRevisionId_fkey" FOREIGN KEY ("organizationId", "itemRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadDocument" ADD CONSTRAINT "CadDocument_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_organizationId_cadDocumentId_fkey" FOREIGN KEY ("organizationId", "cadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

