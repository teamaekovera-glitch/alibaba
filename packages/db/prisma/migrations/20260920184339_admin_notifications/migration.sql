-- CreateEnum
CREATE TYPE "ReviewModerationStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('REORDER_REMINDER', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED', 'REVIEW_MODERATION_DECIDED', 'VERIFICATION_CHANGED', 'ORG_ROLE_CHANGED');

-- Note: `migrate dev` also emits `DROP INDEX "ListingEmbedding_embedding_hnsw"`
-- here because the HNSW cosine index is raw SQL (Prisma cannot express it).
-- That drop is drift noise, not intent — removed; the index stays.

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedByUserId" TEXT,
ADD COLUMN     "moderationStatus" "ReviewModerationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "rejectionReason" TEXT;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkUrl" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_moderationStatus_createdAt_idx" ON "Review"("moderationStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderatedByUserId_fkey" FOREIGN KEY ("moderatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
