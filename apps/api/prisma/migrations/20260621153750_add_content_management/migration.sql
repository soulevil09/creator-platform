-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "ContentTier" AS ENUM ('FREE', 'STANDARD', 'PREMIUM');

-- CreateTable
CREATE TABLE "Content" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "ContentType" NOT NULL,
    "tier" "ContentTier" NOT NULL DEFAULT 'STANDARD',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSecs" INTEGER,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "ppvPriceCents" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAccess" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantReason" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ContentAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Content_modelId_idx" ON "Content"("modelId");

-- CreateIndex
CREATE INDEX "Content_tier_idx" ON "Content"("tier");

-- CreateIndex
CREATE INDEX "Content_isPublished_idx" ON "Content"("isPublished");

-- CreateIndex
CREATE INDEX "ContentAccess_userId_idx" ON "ContentAccess"("userId");

-- CreateIndex
CREATE INDEX "ContentAccess_contentId_idx" ON "ContentAccess"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAccess_contentId_userId_key" ON "ContentAccess"("contentId", "userId");

-- AddForeignKey
ALTER TABLE "Content" ADD CONSTRAINT "Content_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAccess" ADD CONSTRAINT "ContentAccess_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAccess" ADD CONSTRAINT "ContentAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
