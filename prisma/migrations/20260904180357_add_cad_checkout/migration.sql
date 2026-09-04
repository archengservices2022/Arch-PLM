-- CreateTable
CREATE TABLE "CadCheckout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cadDocumentId" TEXT NOT NULL,
    "baseFileVersionId" TEXT NOT NULL,
    "checkedOutById" TEXT NOT NULL,
    "checkedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "CadCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CadCheckout_organizationId_idx" ON "CadCheckout"("organizationId");

-- CreateIndex
CREATE INDEX "CadCheckout_baseFileVersionId_idx" ON "CadCheckout"("baseFileVersionId");

-- CreateIndex
CREATE INDEX "CadCheckout_checkedOutById_idx" ON "CadCheckout"("checkedOutById");

-- CreateIndex
CREATE UNIQUE INDEX "CadCheckout_organizationId_id_key" ON "CadCheckout"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CadCheckout_organizationId_cadDocumentId_key" ON "CadCheckout"("organizationId", "cadDocumentId");

-- AddForeignKey
ALTER TABLE "CadCheckout" ADD CONSTRAINT "CadCheckout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckout" ADD CONSTRAINT "CadCheckout_organizationId_cadDocumentId_fkey" FOREIGN KEY ("organizationId", "cadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckout" ADD CONSTRAINT "CadCheckout_organizationId_baseFileVersionId_fkey" FOREIGN KEY ("organizationId", "baseFileVersionId") REFERENCES "FileVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckout" ADD CONSTRAINT "CadCheckout_organizationId_checkedOutById_fkey" FOREIGN KEY ("organizationId", "checkedOutById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
