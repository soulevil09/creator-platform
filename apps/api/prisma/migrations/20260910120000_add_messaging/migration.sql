-- CreateEnum
CREATE TYPE "MessageAttachmentType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT,
    "attachmentType" "MessageAttachmentType",
    "attachmentStorageKey" TEXT,
    "attachmentMimeType" TEXT,
    "attachmentSizeBytes" INTEGER,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_modelId_lastMessageAt_idx" ON "Conversation"("modelId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_subscriberId_lastMessageAt_idx" ON "Conversation"("subscriberId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_subscriberId_modelId_key" ON "Conversation"("subscriberId", "modelId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- A message must carry something. Prisma has no CHECK primitive, so the guard
-- lives here (same pattern as PaymentTransaction_revenue_split_exhaustive in
-- the payouts migration): a row with neither a body nor an attachment is a bug
-- by construction, and the database refuses it rather than trusting the one
-- application code path that writes messages to keep checking.
ALTER TABLE "Message" ADD CONSTRAINT "Message_body_or_attachment_present" CHECK (
  "body" IS NOT NULL OR "attachmentType" IS NOT NULL
);
