-- Session 06.5 — subscription lifecycle.
--
-- One new column: "will this renew", kept separate from `status` ("what access
-- is live right now") instead of overloading status with a fifth value. A
-- cancelling subscriber stays ACTIVE until the period they paid for actually
-- ends, then lands on CANCELED; a non-payer walks ACTIVE → PAST_DUE → EXPIRED.
-- Defaulting to false means every existing row keeps renewing, which is the
-- status quo before this migration.

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
-- The daily renewal sweep's four passes filter on exactly these three columns,
-- in this order (status is the most selective, currentPeriodEnd is the range).
CREATE INDEX "Subscription_status_cancelAtPeriodEnd_currentPeriodEnd_idx" ON "Subscription"("status", "cancelAtPeriodEnd", "currentPeriodEnd");
