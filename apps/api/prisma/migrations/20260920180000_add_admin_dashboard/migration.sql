-- CreateEnum
CREATE TYPE "ModelApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'ILLEGAL', 'NON_CONSENSUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ModelProfile" ADD COLUMN     "approvalRejectionReason" TEXT,
ADD COLUMN     "approvalReviewedAt" TIMESTAMP(3),
ADD COLUMN     "approvalStatus" "ModelApprovalStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAction" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_contentId_idx" ON "Report"("contentId");

-- CreateIndex
CREATE INDEX "Report_reporterId_idx" ON "Report"("reporterId");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- One PENDING report per (content, reporter). The service answers a repeat
-- report with a 200 no-op, but a "have I already reported this?" check is a
-- read-then-write window two concurrent requests can both pass. Prisma has no
-- partial-index primitive, so the real guard lives here (same pattern as
-- GenerationJob_one_pending_per_subscriber): the second insert rejects with
-- P2002, which the service maps to the no-op. A resolved report drops out of
-- the index, so the same viewer can report the same item again later.
CREATE UNIQUE INDEX "Report_one_pending_per_reporter_content"
  ON "Report"("contentId", "reporterId")
  WHERE "status" = 'PENDING';
