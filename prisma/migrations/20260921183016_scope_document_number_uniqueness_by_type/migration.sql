-- P6D ROUND 2, HIGH fix: CadDocument.documentNumber was unique ORG-WIDE,
-- regardless of documentType - a normal Inventor model/drawing pair (e.g.
-- "1001.ipt" and "1001.idw", the SAME engineering base number as two
-- DIFFERENT CadDocuments per the PDM CAD architecture rule) could never both
-- exist. This migration is SAFE against existing data with no possibility of
-- failure: (organizationId, documentNumber, documentType) uniqueness is
-- STRICTLY LESS restrictive than the (organizationId, documentNumber)
-- uniqueness it replaces - any row set that was valid under the old
-- constraint is automatically valid under the new one (documentNumber
-- already unique per org trivially implies the (documentNumber,
-- documentType) pair is too), so there is no duplicate-row rejection risk.
--
-- ADDITIVE ONLY: no data is dropped, no other column/table is touched.

-- DropIndex
DROP INDEX "CadDocument_organizationId_documentNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "CadDocument_organizationId_documentNumber_documentType_key" ON "CadDocument"("organizationId", "documentNumber", "documentType");
