-- CreateEnum
CREATE TYPE "CopyDesignEntryAction" AS ENUM ('COPY', 'REUSE');

-- CreateTable
CREATE TABLE "CopyDesignOperationEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "copyDesignOperationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "action" "CopyDesignEntryAction" NOT NULL,
    "sourceCadDocumentId" TEXT,
    "sourceFileVersionId" TEXT,
    "resultingCadDocumentId" TEXT NOT NULL,
    "originalDocumentNumber" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "originalDocumentType" "CadDocumentType" NOT NULL,
    "originalDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyDesignOperationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CopyDesignOperationEntry_organizationId_idx" ON "CopyDesignOperationEntry"("organizationId");

-- CreateIndex
CREATE INDEX "CopyDesignOperationEntry_copyDesignOperationId_idx" ON "CopyDesignOperationEntry"("copyDesignOperationId");

-- CreateIndex
CREATE INDEX "CopyDesignOperationEntry_sourceCadDocumentId_idx" ON "CopyDesignOperationEntry"("sourceCadDocumentId");

-- CreateIndex
CREATE INDEX "CopyDesignOperationEntry_resultingCadDocumentId_idx" ON "CopyDesignOperationEntry"("resultingCadDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "CopyDesignOperationEntry_organizationId_id_key" ON "CopyDesignOperationEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CopyDesignOperationEntry_organizationId_copyDesignOperation_key" ON "CopyDesignOperationEntry"("organizationId", "copyDesignOperationId", "ordinal");

-- AddForeignKey
ALTER TABLE "CopyDesignOperationEntry" ADD CONSTRAINT "CopyDesignOperationEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDesignOperationEntry" ADD CONSTRAINT "CopyDesignOperationEntry_organizationId_copyDesignOperatio_fkey" FOREIGN KEY ("organizationId", "copyDesignOperationId") REFERENCES "CopyDesignOperation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDesignOperationEntry" ADD CONSTRAINT "CopyDesignOperationEntry_sourceCadDocument_fkey" FOREIGN KEY ("organizationId", "sourceCadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDesignOperationEntry" ADD CONSTRAINT "CopyDesignOperationEntry_sourceFileVersion_fkey" FOREIGN KEY ("organizationId", "sourceCadDocumentId", "sourceFileVersionId") REFERENCES "FileVersion"("organizationId", "cadDocumentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDesignOperationEntry" ADD CONSTRAINT "CopyDesignOperationEntry_organizationId_resultingCadDocume_fkey" FOREIGN KEY ("organizationId", "resultingCadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
