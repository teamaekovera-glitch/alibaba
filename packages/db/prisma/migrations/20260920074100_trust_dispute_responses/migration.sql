-- CreateTable
CREATE TABLE "DisputeResponse" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisputeResponse_disputeId_createdAt_idx" ON "DisputeResponse"("disputeId", "createdAt");

-- AddForeignKey
ALTER TABLE "DisputeResponse" ADD CONSTRAINT "DisputeResponse_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeResponse" ADD CONSTRAINT "DisputeResponse_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeResponse" ADD CONSTRAINT "DisputeResponse_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
