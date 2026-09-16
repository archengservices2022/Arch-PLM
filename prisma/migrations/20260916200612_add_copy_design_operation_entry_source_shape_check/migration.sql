-- P6B Round 3, MEDIUM: structurally enforce the COPY/REUSE source shape on
-- CopyDesignOperationEntry at the PostgreSQL level. Application code
-- already writes this shape correctly (see applyWithinTransaction in
-- app/lib/copy-design-lineage-db.ts), but durable PLM operation evidence
-- must not depend on application code alone to stay valid - Prisma's schema
-- DSL cannot express a CHECK constraint, so - exactly like
-- CadDependency_no_self_reference in
-- 20260903155138_add_cad_dependency_self_reference_check - it is added here
-- by hand in its own additive migration.
--
-- A COPY entry always names the exact source it was copied from; a REUSE
-- entry names no source at all (its only identity is
-- resultingCadDocumentId). This CHECK makes the opposite - a COPY row
-- missing its source, or a REUSE row carrying one - structurally
-- unrepresentable, independent of the composite FK (which only validates a
-- *non-null* source pair belongs together, and does not by itself forbid a
-- null/non-null mismatch).
ALTER TABLE "CopyDesignOperationEntry"
ADD CONSTRAINT "CopyDesignOperationEntry_source_shape_matches_action"
CHECK (
  ("action" = 'COPY'
    AND "sourceCadDocumentId" IS NOT NULL
    AND "sourceFileVersionId" IS NOT NULL)
  OR
  ("action" = 'REUSE'
    AND "sourceCadDocumentId" IS NULL
    AND "sourceFileVersionId" IS NULL)
);
