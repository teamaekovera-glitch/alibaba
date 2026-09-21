-- Review.orderLineId: the verified-purchase anchor (one review per order line).
-- Moderation columns arrive with the admin/notification migration (20260920184339).

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "orderLineId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Review_orderLineId_key" ON "Review"("orderLineId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
