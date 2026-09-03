-- CreateEnum
CREATE TYPE "CadDependencyType" AS ENUM ('COMPONENT', 'DRAWING_REFERENCE', 'DERIVED', 'REFERENCE', 'OTHER');

-- CreateTable
CREATE TABLE "CadDependency" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "parentDocumentId" TEXT NOT NULL,
    "childDocumentId" TEXT NOT NULL,
    "dependencyType" "CadDependencyType" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CadDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CadDependency_organizationId_idx" ON "CadDependency"("organizationId");

-- CreateIndex
CREATE INDEX "CadDependency_parentDocumentId_idx" ON "CadDependency"("parentDocumentId");

-- CreateIndex
CREATE INDEX "CadDependency_childDocumentId_idx" ON "CadDependency"("childDocumentId");

-- CreateIndex
CREATE INDEX "CadDependency_createdById_idx" ON "CadDependency"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "CadDependency_organizationId_id_key" ON "CadDependency"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CadDependency_organizationId_parentDocumentId_childDocument_key" ON "CadDependency"("organizationId", "parentDocumentId", "childDocumentId", "dependencyType");

-- AddForeignKey
ALTER TABLE "CadDependency" ADD CONSTRAINT "CadDependency_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadDependency" ADD CONSTRAINT "CadDependency_organizationId_parentDocumentId_fkey" FOREIGN KEY ("organizationId", "parentDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadDependency" ADD CONSTRAINT "CadDependency_organizationId_childDocumentId_fkey" FOREIGN KEY ("organizationId", "childDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadDependency" ADD CONSTRAINT "CadDependency_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
