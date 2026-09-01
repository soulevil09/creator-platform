-- AlterTable
ALTER TABLE "ModelProfile" ADD COLUMN     "payoutEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ModelProfile_payoutEmail_key" ON "ModelProfile"("payoutEmail");

