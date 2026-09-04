-- CreateEnum
CREATE TYPE "CadCheckoutEventType" AS ENUM ('CHECKED_OUT', 'CHECKED_IN', 'UNDO_CHECKOUT', 'ADMIN_UNLOCK');

-- CreateTable
CREATE TABLE "CadCheckoutEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cadDocumentId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "baseFileVersionId" TEXT NOT NULL,
    "checkoutOwnerId" TEXT NOT NULL,
    "actedById" TEXT NOT NULL,
    "eventType" "CadCheckoutEventType" NOT NULL,
    "checkedOutAt" TIMESTAMP(3) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "CadCheckoutEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CadCheckoutEvent_organizationId_cadDocumentId_occurredAt_idx" ON "CadCheckoutEvent"("organizationId", "cadDocumentId", "occurredAt");

-- CreateIndex
CREATE INDEX "CadCheckoutEvent_organizationId_checkoutOwnerId_idx" ON "CadCheckoutEvent"("organizationId", "checkoutOwnerId");

-- CreateIndex
CREATE INDEX "CadCheckoutEvent_organizationId_actedById_idx" ON "CadCheckoutEvent"("organizationId", "actedById");

-- AddForeignKey
ALTER TABLE "CadCheckoutEvent" ADD CONSTRAINT "CadCheckoutEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckoutEvent" ADD CONSTRAINT "CadCheckoutEvent_organizationId_cadDocumentId_fkey" FOREIGN KEY ("organizationId", "cadDocumentId") REFERENCES "CadDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckoutEvent" ADD CONSTRAINT "CadCheckoutEvent_organizationId_baseFileVersionId_fkey" FOREIGN KEY ("organizationId", "baseFileVersionId") REFERENCES "FileVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckoutEvent" ADD CONSTRAINT "CadCheckoutEvent_organizationId_checkoutOwnerId_fkey" FOREIGN KEY ("organizationId", "checkoutOwnerId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CadCheckoutEvent" ADD CONSTRAINT "CadCheckoutEvent_organizationId_actedById_fkey" FOREIGN KEY ("organizationId", "actedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
