-- CreateEnum
CREATE TYPE "ReleaseBaselineInclusionKind" AS ENUM ('DIRECT', 'DEPENDENCY');

-- AlterTable
ALTER TABLE "ReleaseBaselineEntry" ADD COLUMN     "inclusionKind" "ReleaseBaselineInclusionKind" NOT NULL DEFAULT 'DIRECT';
