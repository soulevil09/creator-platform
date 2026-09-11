-- CreateEnum
CREATE TYPE "GenerationMode" AS ENUM ('PRESET', 'CUSTOM');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "mode" "GenerationMode" NOT NULL,
    "presetId" TEXT,
    "userPrompt" TEXT,
    "creditsCost" INTEGER NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "providerJobId" TEXT,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationJob_subscriberId_createdAt_idx" ON "GenerationJob"("subscriberId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_modelId_idx" ON "GenerationJob"("modelId");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One in-flight generation per subscriber. The service checks for a PENDING
-- job before debiting (→ 429), but a check is a read-then-write window two
-- concurrent requests can both pass. Prisma has no partial-index primitive, so
-- the real guard lives here (same pattern as the hand-written CHECK
-- constraints in the payouts and messaging migrations): the second insert
-- rejects, and because the debit and the insert share a transaction, the
-- credits it debited roll back with it.
CREATE UNIQUE INDEX "GenerationJob_one_pending_per_subscriber"
  ON "GenerationJob"("subscriberId")
  WHERE "status" = 'PENDING';
