-- Defense-in-depth for the application-level self-reference guard in
-- createCadDependency(). Prisma's schema DSL cannot express a CHECK
-- constraint, so it is added here by hand in a dedicated migration.
--
-- A CAD document must never depend on itself.
ALTER TABLE "CadDependency"
ADD CONSTRAINT "CadDependency_no_self_reference"
CHECK ("parentDocumentId" <> "childDocumentId");
