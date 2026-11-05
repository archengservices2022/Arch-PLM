-- Option A: legacy revalidation audit link (+ enum value LEGACY_REVALIDATION).
--
-- Purely additive:
--   * adds the value 'LEGACY_REVALIDATION' to "LifecycleEventTrigger";
--   * creates the append-only table "ItemRevisionLegacyRevalidation" with its
--     indexes, organization-scoped RESTRICT foreign keys and the same
--     append-only triggers as the B03 tables (reusing "arch_append_only_guard"
--     from migration 20261105082314_add_item_revision_lifecycle_events).
-- No existing table, column, index, hold, event or row is changed, and no row
-- is written: revalidation rows are created only by the application.
--
-- ATOMICITY: one explicit transaction (BEGIN ... COMMIT). PostgreSQL 12+
-- allows ALTER TYPE ... ADD VALUE inside a transaction block; the new value is
-- not used before COMMIT. Any error rolls back the enum value, the table and
-- the triggers together. A self-check before COMMIT refuses to commit unless
-- the enum value, the table, both triggers and the guard function exist.
--
-- DEPLOYMENT: follows the B03 fail-closed maintenance procedure (writers
-- stopped and verified, migrate, verify, resume only with authorization). No
-- backfill, so no hold coverage concern; the procedure still applies because
-- the release must ship together with the matching application code.
--
-- The statements between "Generated" and "Hand-written" were generated
-- offline with
--   prisma migrate diff --from-schema-datamodel <schema at ead709e>
--                       --to-schema-datamodel prisma/schema.prisma --script
-- (no database connection).

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ------------------------------------------------------------
-- Generated
-- ------------------------------------------------------------

-- AlterEnum
ALTER TYPE "LifecycleEventTrigger" ADD VALUE 'LEGACY_REVALIDATION';

-- CreateTable
CREATE TABLE "ItemRevisionLegacyRevalidation" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "legacyRevisionId" TEXT NOT NULL,
    "successorRevisionId" TEXT NOT NULL,
    "actedById" TEXT NOT NULL,
    "actedByRole" "UserRole" NOT NULL,
    "comment" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemRevisionLegacyRevalidation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLegacyRevalidation_sequence_key" ON "ItemRevisionLegacyRevalidation"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLegacyRevalidation_legacyRevisionId_key" ON "ItemRevisionLegacyRevalidation"("legacyRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLegacyRevalidation_successorRevisionId_key" ON "ItemRevisionLegacyRevalidation"("successorRevisionId");

-- CreateIndex
CREATE INDEX "ItemRevisionLegacyRevalidation_organizationId_actedById_idx" ON "ItemRevisionLegacyRevalidation"("organizationId", "actedById");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLegacyRevalidation_organizationId_legacyRevisio_key" ON "ItemRevisionLegacyRevalidation"("organizationId", "legacyRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLegacyRevalidation_organizationId_successorRevi_key" ON "ItemRevisionLegacyRevalidation"("organizationId", "successorRevisionId");

-- AddForeignKey
ALTER TABLE "ItemRevisionLegacyRevalidation" ADD CONSTRAINT "ItemRevisionLegacyRevalidation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLegacyRevalidation" ADD CONSTRAINT "ItemRevisionLegacyRevalidation_organizationId_legacyRevisi_fkey" FOREIGN KEY ("organizationId", "legacyRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLegacyRevalidation" ADD CONSTRAINT "ItemRevisionLegacyRevalidation_organizationId_successorRev_fkey" FOREIGN KEY ("organizationId", "successorRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLegacyRevalidation" ADD CONSTRAINT "ItemRevisionLegacyRevalidation_organizationId_actedById_fkey" FOREIGN KEY ("organizationId", "actedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ------------------------------------------------------------
-- Hand-written 1/2: append-only enforcement, same guard function as B03.
-- ------------------------------------------------------------
CREATE TRIGGER "ItemRevisionLegacyRevalidation_append_only_row"
  BEFORE UPDATE OR DELETE ON "ItemRevisionLegacyRevalidation"
  FOR EACH ROW EXECUTE FUNCTION "arch_append_only_guard"();

CREATE TRIGGER "ItemRevisionLegacyRevalidation_append_only_truncate"
  BEFORE TRUNCATE ON "ItemRevisionLegacyRevalidation"
  FOR EACH STATEMENT EXECUTE FUNCTION "arch_append_only_guard"();

-- ------------------------------------------------------------
-- Hand-written 2/2: self-check before COMMIT (fail closed).
-- ------------------------------------------------------------
DO $$
DECLARE
  enum_value bigint;
  table_count bigint;
  triggers bigint;
  guard bigint;
BEGIN
  SELECT count(*) INTO enum_value
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'LifecycleEventTrigger' AND e.enumlabel = 'LEGACY_REVALIDATION';
  SELECT count(*) INTO table_count
    FROM information_schema.tables
   WHERE table_schema = current_schema() AND table_name = 'ItemRevisionLegacyRevalidation';
  SELECT count(*) INTO triggers
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'ItemRevisionLegacyRevalidation_append_only_row',
       'ItemRevisionLegacyRevalidation_append_only_truncate');
  SELECT count(*) INTO guard FROM pg_proc WHERE proname = 'arch_append_only_guard';
  IF enum_value <> 1 OR table_count <> 1 OR triggers <> 2 OR guard <> 1 THEN
    RAISE EXCEPTION 'Option A migration self-check failed: enum=% table=% triggers=% guard=%', enum_value, table_count, triggers, guard;
  END IF;
END
$$;

COMMIT;
