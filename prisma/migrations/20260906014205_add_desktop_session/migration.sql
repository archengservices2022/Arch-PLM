-- CreateTable
CREATE TABLE "DesktopSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DesktopSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesktopSession_tokenHash_key" ON "DesktopSession"("tokenHash");

-- CreateIndex
CREATE INDEX "DesktopSession_organizationId_idx" ON "DesktopSession"("organizationId");

-- CreateIndex
CREATE INDEX "DesktopSession_userId_idx" ON "DesktopSession"("userId");

-- CreateIndex
CREATE INDEX "DesktopSession_expiresAt_idx" ON "DesktopSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "DesktopSession" ADD CONSTRAINT "DesktopSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesktopSession" ADD CONSTRAINT "DesktopSession_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
