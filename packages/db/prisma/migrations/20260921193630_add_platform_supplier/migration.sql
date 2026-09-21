-- Note: `migrate dev` also emits `DROP INDEX "ListingEmbedding_embedding_hnsw"`
-- here because the HNSW cosine index is raw SQL (Prisma cannot express it).
-- That drop is drift noise, not intent — removed; the index stays.

-- CreateTable
CREATE TABLE "PlatformSupplier" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dba" TEXT,
    "supplierTypes" TEXT[],
    "specialty" TEXT,
    "products" TEXT,
    "description" TEXT,
    "primaryEmail" TEXT,
    "generalEmail" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "linkedin" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "country" TEXT,
    "certifications" TEXT[],
    "yearFounded" TEXT,
    "companySize" TEXT,
    "tier" INTEGER,
    "aiConfidence" DOUBLE PRECISION,
    "primaryCategory" TEXT NOT NULL,
    "categorySlugs" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSupplier_slug_key" ON "PlatformSupplier"("slug");

-- CreateIndex
CREATE INDEX "PlatformSupplier_primaryCategory_idx" ON "PlatformSupplier"("primaryCategory");

-- CreateIndex
CREATE INDEX "PlatformSupplier_state_idx" ON "PlatformSupplier"("state");

-- CreateIndex
CREATE INDEX "PlatformSupplier_categorySlugs_idx" ON "PlatformSupplier" USING GIN ("categorySlugs");
