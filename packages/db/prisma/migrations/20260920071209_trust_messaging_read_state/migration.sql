-- CreateTable
CREATE TABLE "ThreadReadState" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE UNIQUE INDEX "ThreadReadState_threadId_orgId_key" ON "ThreadReadState"("threadId", "orgId");

-- CreateTable
CREATE INDEX "ThreadReadState_orgId_threadId_idx" ON "ThreadReadState"("orgId", "threadId");

-- AddForeignKey
ALTER TABLE "ThreadReadState" ADD CONSTRAINT "ThreadReadState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadReadState" ADD CONSTRAINT "ThreadReadState_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
