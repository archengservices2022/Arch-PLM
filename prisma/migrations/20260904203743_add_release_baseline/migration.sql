-- CreateTable
CREATE TABLE "ReleaseBaseline" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemRevisionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseBaselineEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "releaseBaselineId" TEXT NOT NULL,
    "cadDocumentId" TEXT NOT NULL,
    "fileVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseBaselineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReleaseBaseline_organizationId_idx" ON "ReleaseBaseline"("organizationId");

-- CreateIndex
CREATE INDEX "ReleaseBaseline_createdById_idx" ON "ReleaseBaseline"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseBaseline_organizationId_id_key" ON "ReleaseBaseline"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseBaseline_organizationId_itemRevisionId_key" ON "ReleaseBaseline"("organizationId", "itemRevisionId");

-- CreateIndex
CREATE INDEX "ReleaseBaselineEntry_organizationId_idx" ON "ReleaseBaselineEntry"("organizationId");

-- CreateIndex
CREATE INDEX "ReleaseBaselineEntry_releaseBaselineId_idx" ON "ReleaseBaselineEntry"("releaseBaselineId");

-- CreateIndex
CREATE INDEX "ReleaseBaselineEntry_cadDocumentId_idx" ON "ReleaseBaselineEntry"("cadDocumentId");

-- CreateIndex
CREATE INDEX "ReleaseBaselineEntry_fileVersionId_idx" ON "ReleaseBaselineEntry"("fileVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseBaselineEntry_organizationId_id_key" ON "ReleaseBaselineEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseBaselineEntry_releaseBaselineId_cadDocumentId_key" ON "ReleaseBaselineEntry"("releaseBaselineId", "cadDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_organizationId_cadDocumentId_id_key" ON "FileVersion"("organizationId", "cadDocumentId", "id");

-- AddForeignKey
ALTER TABLE "ReleaseBaseline" ADD CONSTRAINT "ReleaseBaseline_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBaseline" ADD CONSTRAINT "ReleaseBaseline_organizationId_itemRevisionId_fkey" FOREIGN KEY ("organizationId", "itemRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBaseline" ADD CONSTRAINT "ReleaseBaseline_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBaselineEntry" ADD CONSTRAINT "ReleaseBaselineEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBaselineEntry" ADD CONSTRAINT "ReleaseBaselineEntry_organizationId_releaseBaselineId_fkey" FOREIGN KEY ("organizationId", "releaseBaselineId") REFERENCES "ReleaseBaseline"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBaselineEntry" ADD CONSTRAINT "ReleaseBaselineEntry_organizationId_cadDocumentId_fkey" FOREIGN KEY ("organizationId", "cadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseBaselineEntry" ADD CONSTRAINT "ReleaseBaselineEntry_organizationId_cadDocumentId_fileVers_fkey" FOREIGN KEY ("organizationId", "cadDocumentId", "fileVersionId") REFERENCES "FileVersion"("organizationId", "cadDocumentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

