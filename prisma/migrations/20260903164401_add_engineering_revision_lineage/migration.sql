-- Milestone 3: engineering revision audit lineage.
--
-- DEPLOY SAFETY: `createdById` is added NULLABLE and is NOT backfilled.
-- ItemRevision rows created before this milestone have no recoverable
-- author, and inventing one would be worse than a NULL. Application code
-- (createItem, createEngineeringRevision) always sets
-- createdById = actor.userId for every revision it creates, so only
-- pre-milestone historical rows can be NULL ("created before lineage
-- tracking existed"). A future data migration can populate historical
-- rows from an authoritative source and then tighten the column to
-- NOT NULL; that is intentionally out of scope here.
--
-- The composite FK on (organizationId, createdById) uses PostgreSQL's
-- default MATCH SIMPLE semantics: a row with createdById = NULL is not
-- checked against User, while a non-NULL createdById must reference a
-- User in the same organization.

-- AlterTable
ALTER TABLE "ItemRevision" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "sourceRevisionId" TEXT;

-- CreateIndex
CREATE INDEX "ItemRevision_createdById_idx" ON "ItemRevision"("createdById");

-- CreateIndex
CREATE INDEX "ItemRevision_sourceRevisionId_idx" ON "ItemRevision"("sourceRevisionId");

-- AddForeignKey
ALTER TABLE "ItemRevision" ADD CONSTRAINT "ItemRevision_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemRevision" ADD CONSTRAINT "ItemRevision_organizationId_sourceRevisionId_fkey" FOREIGN KEY ("organizationId", "sourceRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
