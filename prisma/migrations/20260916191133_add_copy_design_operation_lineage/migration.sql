-- CreateTable
CREATE TABLE "CopyDesignOperation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT,
    "requestPayload" JSONB NOT NULL,

    CONSTRAINT "CopyDesignOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CadCopyLineage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "copyDesignOperationId" TEXT NOT NULL,
    "newCadDocumentId" TEXT NOT NULL,
    "sourceCadDocumentId" TEXT NOT NULL,
    "sourceFileVersionId" TEXT NOT NULL,
    "copiedById" TEXT NOT NULL,
    "copiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CadCopyLineage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CopyDesignOperation_organizationId_idx" ON "CopyDesignOperation"("organizationId");

-- CreateIndex
CREATE INDEX "CopyDesignOperation_performedById_idx" ON "CopyDesignOperation"("performedById");

-- CreateIndex
CREATE UNIQUE INDEX "CopyDesignOperation_organizationId_id_key" ON "CopyDesignOperation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CopyDesignOperation_organizationId_idempotencyKey_key" ON "CopyDesignOperation"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CadCopyLineage_organizationId_idx" ON "CadCopyLineage"("organizationId");

-- CreateIndex
CREATE INDEX "CadCopyLineage_copyDesignOperationId_idx" ON "CadCopyLineage"("copyDesignOperationId");

-- CreateIndex
CREATE INDEX "CadCopyLineage_sourceCadDocumentId_idx" ON "CadCopyLineage"("sourceCadDocumentId");

-- CreateIndex
CREATE INDEX "CadCopyLineage_copiedById_idx" ON "CadCopyLineage"("copiedById");

-- CreateIndex
CREATE UNIQUE INDEX "CadCopyLineage_organizationId_id_key" ON "CadCopyLineage"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CadCopyLineage_organizationId_newCadDocumentId_key" ON "CadCopyLineage"("organizationId", "newCadDocumentId");

-- AddForeignKey
ALTER TABLE "CopyDesignOperation" ADD CONSTRAINT "CopyDesignOperation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDesignOperation" ADD CONSTRAINT "CopyDesignOperation_organizationId_performedById_fkey" FOREIGN KEY ("organizationId", "performedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCopyLineage" ADD CONSTRAINT "CadCopyLineage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCopyLineage" ADD CONSTRAINT "CadCopyLineage_organizationId_copyDesignOperationId_fkey" FOREIGN KEY ("organizationId", "copyDesignOperationId") REFERENCES "CopyDesignOperation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCopyLineage" ADD CONSTRAINT "CadCopyLineage_organizationId_newCadDocumentId_fkey" FOREIGN KEY ("organizationId", "newCadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCopyLineage" ADD CONSTRAINT "CadCopyLineage_organizationId_sourceCadDocumentId_fkey" FOREIGN KEY ("organizationId", "sourceCadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCopyLineage" ADD CONSTRAINT "CadCopyLineage_organizationId_sourceCadDocumentId_sourceFi_fkey" FOREIGN KEY ("organizationId", "sourceCadDocumentId", "sourceFileVersionId") REFERENCES "FileVersion"("organizationId", "cadDocumentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCopyLineage" ADD CONSTRAINT "CadCopyLineage_organizationId_copiedById_fkey" FOREIGN KEY ("organizationId", "copiedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
