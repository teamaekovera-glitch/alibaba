-- CreateEnum
CREATE TYPE "ReviewModerationStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedByUserId" TEXT,
ADD COLUMN     "moderationStatus" "ReviewModerationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "orderLineId" TEXT,
ADD COLUMN     "rejectionReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Review_orderLineId_key" ON "Review"("orderLineId");

-- CreateIndex
CREATE INDEX "Review_moderationStatus_createdAt_idx" ON "Review"("moderationStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderatedByUserId_fkey" FOREIGN KEY ("moderatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
