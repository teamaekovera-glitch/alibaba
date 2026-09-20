import { K_ANONYMITY_MIN, getPriceBenchmarks, getLeadTimeBenchmarks, QTY_BANDS } from "@packsource/benchmarks";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Buyer-facing benchmark read API (spec: analytics — k-anonymous benchmarks).
 * Any authenticated marketplace user may read: the k ≥ 5 anonymity threshold
 * is the privacy boundary, and rows below it never exist to read (enforced
 * again here, not just at write). Filters: `category` (slug), `qtyBand`
 * (canonical key), `material` (e.g. PET).
 */
export const dynamic = "force-dynamic";

const BAND_KEYS = new Set(QTY_BANDS.map((band) => band.key));

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "authentication required" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const categorySlug = searchParams.get("category");
  const qtyBand = searchParams.get("qtyBand");
  const material = searchParams.get("material");

  if (qtyBand !== null && !BAND_KEYS.has(qtyBand)) {
    return Response.json(
      { error: `unknown qtyBand — canonical keys: ${[...BAND_KEYS].join(", ")}` },
      { status: 400 },
    );
  }

  let categoryId: string | undefined;
  if (categorySlug !== null) {
    const category = await db.category.findUnique({ where: { slug: categorySlug }, select: { id: true } });
    if (!category) {
      return Response.json({ error: `unknown category slug: ${categorySlug}` }, { status: 400 });
    }
    categoryId = category.id;
  }

  try {
    const filters = { categoryId, qtyBand: qtyBand ?? undefined, material: material ?? undefined };
    const [price, leadTime] = await Promise.all([
      getPriceBenchmarks(db, filters),
      getLeadTimeBenchmarks(db, filters),
    ]);
    return Response.json({
      k: K_ANONYMITY_MIN,
      filters: { category: categorySlug, qtyBand, material },
      price,
      leadTime,
    });
  } catch (error) {
    console.error("[/api/benchmarks] read failed", error);
    return Response.json({ error: "benchmark reads are temporarily unavailable" }, { status: 503 });
  }
}
