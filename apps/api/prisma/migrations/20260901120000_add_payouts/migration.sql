-- CreateEnum
CREATE TYPE "PayoutProvider" AS ENUM ('PAXUM', 'PAXUM_MOCK');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "modelShareCents" INTEGER,
ADD COLUMN     "payoutId" TEXT,
ADD COLUMN     "platformShareCents" INTEGER;

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "provider" "PayoutProvider" NOT NULL,
    "providerPayoutId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_modelId_idx" ON "Payout"("modelId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE INDEX "Payout_createdAt_idx" ON "Payout"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_modelId_payoutId_idx" ON "PaymentTransaction"("modelId", "payoutId");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- The revenue split must be exhaustive. Prisma has no CHECK primitive, so the
-- guard lives here (same pattern as CreditWallet_balance_non_negative in the
-- payments migration): either both shares are absent — CREDIT_PACK rows, which
-- have no per-model attribution yet — or they are both non-negative and add up
-- to exactly `amount`. A rounding bug that leaked or invented a cent would fail
-- the write instead of quietly mis-paying a model.
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_revenue_split_exhaustive" CHECK (
  ("modelShareCents" IS NULL AND "platformShareCents" IS NULL)
  OR (
    "modelShareCents" >= 0
    AND "platformShareCents" >= 0
    AND "modelShareCents" + "platformShareCents" = "amount"
  )
);

-- A payout is only ever created for a balance above the minimum threshold, so
-- a zero or negative transfer is a bug by construction.
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_amount_positive" CHECK ("amountCents" > 0);
