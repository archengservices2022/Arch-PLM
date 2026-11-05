-- B03: append-only engineering revision lifecycle history + legacy hold.
--
-- Revised after Codex NO-GO (findings 1 and 3). This migration has NOT been
-- applied to any shared database; an EARLIER draft was applied only to the
-- disposable scratch database arch_plm_b03_scratch (kept as evidence, now
-- stale - it lacks "sequence" and the legacy hold table).
--
-- Effect on existing data:
--   * No existing table, column, index or row is changed or deleted.
--   * No lifecycle event is backfilled or fabricated.
--   * ONE row per existing ItemRevision is inserted into
--     "ItemRevisionLegacyLifecycleHold" (finding 1): those revisions' pre-B03
--     submission history cannot be verified, so approve/release stay refused
--     for them. Revisions created after this migration get no hold.
--
-- ATOMICITY (Codex CONDITIONAL GO): the whole migration runs in ONE explicit
-- transaction (BEGIN ... COMMIT below). Schema creation, the legacy-hold
-- backfill, trigger installation and the final self-check succeed or fail
-- together; any error rolls everything back and leaves the database exactly
-- as it was. ItemRevision is locked against writers for the duration
-- (fail fast after lock_timeout rather than wait), and the self-check at the
-- end refuses to COMMIT unless every existing revision has exactly its hold
-- and all four append-only triggers exist.
--
-- DEPLOYMENT REQUIREMENT (fail-closed maintenance procedure, see
-- B03-MIGRATION-MAINTENANCE-PROCEDURE.md): stop ALL application writers and
-- verify they are stopped, run this migration, verify hold coverage and the
-- triggers, and resume only after separate deployment authorization. No
-- old-version instance may create or transition revisions between this
-- migration and the B03 application starting, otherwise such a revision
-- would escape the hold.
--
-- The statements between "Generated" and "Hand-written" were generated
-- offline with
--   prisma migrate diff --from-schema-datamodel <schema at f1bf9f1>
--                       --to-schema-datamodel prisma/schema.prisma --script
-- (no database connection).

BEGIN;

-- Fail fast instead of queueing behind (or ahead of) a live writer.
SET LOCAL lock_timeout = '10s';
-- No revision may be created, changed or deleted while the hold set is taken.
LOCK TABLE "ItemRevision" IN SHARE ROW EXCLUSIVE MODE;

-- ------------------------------------------------------------
-- Generated
-- ------------------------------------------------------------

-- CreateEnum
CREATE TYPE "LifecycleEventTrigger" AS ENUM ('MANUAL', 'AUTOMATIC_SUPERSESSION');

-- CreateTable
CREATE TABLE "ItemRevisionLifecycleEvent" (
    "id" TEXT NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemRevisionId" TEXT NOT NULL,
    "fromState" "LifecycleState" NOT NULL,
    "toState" "LifecycleState" NOT NULL,
    "trigger" "LifecycleEventTrigger" NOT NULL,
    "actedById" TEXT NOT NULL,
    "actedByRole" "UserRole" NOT NULL,
    "comment" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemRevisionLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemRevisionLegacyLifecycleHold" (
    "itemRevisionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lifecycleAtHold" "LifecycleState" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemRevisionLegacyLifecycleHold_pkey" PRIMARY KEY ("itemRevisionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLifecycleEvent_sequence_key" ON "ItemRevisionLifecycleEvent"("sequence");

-- CreateIndex
CREATE INDEX "ItemRevisionLifecycleEvent_organizationId_itemRevisionId_se_idx" ON "ItemRevisionLifecycleEvent"("organizationId", "itemRevisionId", "sequence");

-- CreateIndex
CREATE INDEX "ItemRevisionLifecycleEvent_organizationId_actedById_idx" ON "ItemRevisionLifecycleEvent"("organizationId", "actedById");

-- CreateIndex
CREATE INDEX "ItemRevisionLegacyLifecycleHold_organizationId_idx" ON "ItemRevisionLegacyLifecycleHold"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemRevisionLegacyLifecycleHold_organizationId_itemRevision_key" ON "ItemRevisionLegacyLifecycleHold"("organizationId", "itemRevisionId");

-- AddForeignKey
ALTER TABLE "ItemRevisionLifecycleEvent" ADD CONSTRAINT "ItemRevisionLifecycleEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLifecycleEvent" ADD CONSTRAINT "ItemRevisionLifecycleEvent_organizationId_itemRevisionId_fkey" FOREIGN KEY ("organizationId", "itemRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLifecycleEvent" ADD CONSTRAINT "ItemRevisionLifecycleEvent_organizationId_actedById_fkey" FOREIGN KEY ("organizationId", "actedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLegacyLifecycleHold" ADD CONSTRAINT "ItemRevisionLegacyLifecycleHold_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemRevisionLegacyLifecycleHold" ADD CONSTRAINT "ItemRevisionLegacyLifecycleHold_organizationId_itemRevisio_fkey" FOREIGN KEY ("organizationId", "itemRevisionId") REFERENCES "ItemRevision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ------------------------------------------------------------
-- Hand-written 1/2: legacy hold for every revision that exists now
-- (Codex NO-GO finding 1). Records a fact ("this revision's pre-B03 history
-- is unverifiable"); does not touch the revision, its creator or its state.
-- ------------------------------------------------------------
INSERT INTO "ItemRevisionLegacyLifecycleHold" ("itemRevisionId", "organizationId", "lifecycleAtHold", "recordedAt")
SELECT "id", "organizationId", "lifecycle", CURRENT_TIMESTAMP
FROM "ItemRevision";

-- ------------------------------------------------------------
-- Hand-written 2/2: append-only enforcement (Product Owner decision D-A8)
-- on BOTH tables. The application only ever INSERTs into the event table and
-- never writes the hold table. These triggers make the database itself
-- reject UPDATE, DELETE and TRUNCATE, so neither history nor a hold can be
-- rewritten or removed by application code, an ad-hoc script or a cascade
-- (the foreign keys are also RESTRICT). Prisma's schema language cannot
-- express triggers, so this block exists only in this migration.
--
-- Manual rollback (only on a database where nothing depends on these tables,
-- and only with explicit approval):
--   DROP TABLE "ItemRevisionLegacyLifecycleHold";
--   DROP TABLE "ItemRevisionLifecycleEvent";
--   DROP FUNCTION "arch_append_only_guard"();
--   DROP TYPE "LifecycleEventTrigger";
-- ------------------------------------------------------------
CREATE FUNCTION "arch_append_only_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "ItemRevisionLifecycleEvent_append_only_row"
  BEFORE UPDATE OR DELETE ON "ItemRevisionLifecycleEvent"
  FOR EACH ROW EXECUTE FUNCTION "arch_append_only_guard"();

CREATE TRIGGER "ItemRevisionLifecycleEvent_append_only_truncate"
  BEFORE TRUNCATE ON "ItemRevisionLifecycleEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "arch_append_only_guard"();

CREATE TRIGGER "ItemRevisionLegacyLifecycleHold_append_only_row"
  BEFORE UPDATE OR DELETE ON "ItemRevisionLegacyLifecycleHold"
  FOR EACH ROW EXECUTE FUNCTION "arch_append_only_guard"();

CREATE TRIGGER "ItemRevisionLegacyLifecycleHold_append_only_truncate"
  BEFORE TRUNCATE ON "ItemRevisionLegacyLifecycleHold"
  FOR EACH STATEMENT EXECUTE FUNCTION "arch_append_only_guard"();

-- ------------------------------------------------------------
-- Self-check before COMMIT (fail closed): every existing revision has exactly
-- one hold in its own organization recording its current state, no hold
-- points at a missing revision, and all four append-only triggers exist.
-- Any violation raises, and the whole transaction rolls back.
-- ------------------------------------------------------------
DO $$
DECLARE
  revisions bigint;
  holds bigint;
  matched bigint;
  triggers bigint;
BEGIN
  SELECT count(*) INTO revisions FROM "ItemRevision";
  SELECT count(*) INTO holds FROM "ItemRevisionLegacyLifecycleHold";
  SELECT count(*) INTO matched
    FROM "ItemRevision" r
    JOIN "ItemRevisionLegacyLifecycleHold" h
      ON h."itemRevisionId" = r."id"
     AND h."organizationId" = r."organizationId"
     AND h."lifecycleAtHold" = r."lifecycle";
  SELECT count(*) INTO triggers
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN (
       'ItemRevisionLifecycleEvent_append_only_row',
       'ItemRevisionLifecycleEvent_append_only_truncate',
       'ItemRevisionLegacyLifecycleHold_append_only_row',
       'ItemRevisionLegacyLifecycleHold_append_only_truncate');
  IF holds <> revisions OR matched <> revisions THEN
    RAISE EXCEPTION 'B03 migration self-check failed: % revisions, % holds, % matching holds', revisions, holds, matched;
  END IF;
  IF triggers <> 4 THEN
    RAISE EXCEPTION 'B03 migration self-check failed: % of 4 append-only triggers present', triggers;
  END IF;
END
$$;

COMMIT;
