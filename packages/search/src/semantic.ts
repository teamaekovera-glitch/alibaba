import type { EmbeddingAdapter } from "@packsource/ai";
import type { PrismaClient } from "@packsource/db";
import { listingGraphArgs } from "./listing-graph";
import { listingGraphToDocument } from "./facets";
import type { ListingFilters, ListingSearchDocument, ListingSearchIndex } from "./types";
import { matchesFilters } from "./filtering";

/**
 * pgvector semantic search over ListingEmbedding rows.
 *
 * Embeddings are stored in the production `vector(1536)` column. The
 * deterministic mock adapter produces 8-dim vectors, so they are zero-padded
 * to 1536 — appended zeros change neither vector norms nor dot products, so
 * cosine similarity is preserved exactly and no schema change is needed.
 * Real provider adapters that emit 1536-dim vectors pass through untouched.
 */

export const EMBEDDING_DIMENSIONS = 1536;

/** Cosine distance query results, similarity in [0, 1]. */
export interface SemanticMatch {
  listingId: string;
  similarity: number;
}

/**
 * Serialize a vector into pgvector's text literal ("[0.1,0.2,...]"). Prisma
 * serializes a JS number[] parameter as a Postgres array, which pgvector's
 * ::vector cast rejects, so raw-SQL vectors always travel as text.
 */
export function vectorToPgLiteral(vector: number[]): string {
  return `[${vector.map((value) => String(value)).join(",")}]`;
}

/** Zero-pad (or truncate) an adapter vector to the storage dimension. */
export function padVectorToDimensions(
  vector: number[],
  dimensions: number = EMBEDDING_DIMENSIONS,
): number[] {
  if (vector.length > dimensions) return vector.slice(0, dimensions);
  if (vector.length === dimensions) return vector;
  return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
}

/**
 * Deterministic embedding input for a listing document — the same title + body
 * text the facet documents expose, so embedded content and searchable content
 * cannot drift.
 */
export function semanticInputText(doc: Pick<ListingSearchDocument, "title" | "body">): string {
  return `${doc.title}. ${doc.body}`;
}

export interface BackfillOptions {
  /** Listings per embedBatch call (default 100). */
  batchSize?: number;
  /** Re-embed listings that already have a TITLE embedding (default false). */
  overwrite?: boolean;
  /** Cap the number of listings processed (default unlimited). */
  limit?: number;
}

export interface BackfillResult {
  processed: number;
  skipped: number;
  model: string;
  dimensions: number;
}

const BACKFILL_KIND = "TITLE";

/**
 * Cursor-paginated backfill: embeds title + body text for every LIVE listing
 * and upserts a TITLE ListingEmbedding row. Raw SQL is required for the
 * Unsupported vector column (Prisma cannot write it through the typed client).
 */
export async function backfillListingEmbeddings(
  prisma: PrismaClient,
  embedding: EmbeddingAdapter,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? 100;
  const now = new Date();
  let cursor: string | undefined;
  let processed = 0;
  let skipped = 0;
  let model = "unknown";
  let dimensions = EMBEDDING_DIMENSIONS;

  for (;;) {
    const graphs = await prisma.listing.findMany({
      where: { status: "LIVE", ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: batchSize,
      ...listingGraphArgs,
    });
    if (graphs.length === 0) break;

    const existing = options.overwrite
      ? new Set<string>()
      : new Set(
          (
            await prisma.listingEmbedding.findMany({
              where: { listingId: { in: graphs.map((graph) => graph.id) }, kind: BACKFILL_KIND },
              select: { listingId: true },
            })
          ).map((row) => row.listingId),
        );

    const pending = graphs
      .filter((graph) => !existing.has(graph.id))
      .map((graph) => ({ graph, document: listingGraphToDocument(graph, now) }));

    if (pending.length > 0) {
      const inputs = pending.map(({ document }) => semanticInputText(document));
      const responses = await embedding.embedBatch(inputs);
      for (const [i, response] of responses.entries()) {
        const { graph, document } = pending[i]!;
        const vector = padVectorToDimensions(response.vector);
        if (dimensions !== vector.length || model !== response.model) {
          model = response.model;
          dimensions = vector.length;
        }
        await prisma.$executeRaw`
          INSERT INTO "ListingEmbedding"
            (id, "listingId", "orgId", kind, model, dimensions, embedding, "textPreview", "updatedAt")
          VALUES (
            ${crypto.randomUUID()}, ${graph.id}, ${graph.orgId}, ${BACKFILL_KIND}::"EmbeddingKind",
            ${response.model}, ${vector.length}::int, ${vectorToPgLiteral(vector)}::vector,
            ${semanticInputText(document).slice(0, 200)}, now()
          )
          ON CONFLICT ("listingId", kind) DO UPDATE SET
            model = EXCLUDED.model, dimensions = EXCLUDED.dimensions,
            embedding = EXCLUDED.embedding, "textPreview" = EXCLUDED."textPreview",
            "updatedAt" = now()`;
        processed += 1;
      }
    }

    skipped += graphs.length - pending.length;
    cursor = graphs[graphs.length - 1]?.id;
    if (options.limit != null && processed >= options.limit) break;
  }

  return { processed, skipped, model, dimensions };
}

/**
 * Cosine-ranked semantic search against the HNSW index: embed the query text,
 * order ListingEmbedding rows by cosine distance, and join to LIVE listings.
 */
export async function semanticSearchListings(
  prisma: PrismaClient,
  embedding: EmbeddingAdapter,
  query: { text: string; limit?: number; kind?: "TITLE" | "ATTRIBUTES" | "SPEC_TEXT" | "VISUAL" },
): Promise<SemanticMatch[]> {
  const response = await embedding.embed(query.text);
  const vector = padVectorToDimensions(response.vector);
  const kind = query.kind ?? "TITLE";
  const limit = Math.min(query.limit ?? 10, 100);

  const vectorLiteral = vectorToPgLiteral(vector);
  const rows = await prisma.$queryRaw<{ listingId: string; similarity: number }[]>`
    SELECT le."listingId" AS "listingId", 1 - (le.embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM "ListingEmbedding" le
    JOIN "Listing" l ON l.id = le."listingId"
    WHERE le.kind = ${kind}::"EmbeddingKind" AND l.status = 'LIVE'::"ListingStatus"
    ORDER BY le.embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}::int`;

  return rows.map((row) => ({ listingId: row.listingId, similarity: Number(row.similarity) }));
}

export interface HybridOptions {
  /** Keyword-path facet filters (default none). */
  filters?: ListingFilters;
  limit?: number;
  /** Relative hybrid weights (default keyword 0.6 / semantic 0.4 per spec). */
  keywordWeight?: number;
  semanticWeight?: number;
}

export interface HybridMatch {
  listingId: string;
  score: number;
  keywordScore: number;
  semanticScore: number;
}

/**
 * Hybrid query path (keyword ∪ semantic): the keyword/keyword-facet path runs
 * through the ListingSearchIndex (scores already in [0,1]); the semantic path
 * is min-max normalized over its own candidate set (raw cosine similarity
 * ranges are arbitrary). Combined score = keywordWeight * keyword +
 * semanticWeight * semantic. Listings absent from one path score 0 there.
 */
export async function hybridSearchListings(
  prisma: PrismaClient,
  index: ListingSearchIndex,
  embedding: EmbeddingAdapter,
  query: { q: string } & HybridOptions,
): Promise<HybridMatch[]> {
  const keywordWeight = query.keywordWeight ?? 0.6;
  const semanticWeight = query.semanticWeight ?? 0.4;
  const limit = Math.min(query.limit ?? 10, 100);
  const candidateLimit = limit * 3;

  const [keyword, semantic] = await Promise.all([
    index.search({ q: query.q, filters: query.filters, limit: candidateLimit }),
    semanticSearchListings(prisma, embedding, { text: query.q, limit: candidateLimit }),
  ]);

  // Min-max normalize semantic similarity over the candidate set.
  const similarities = semantic.map((match) => match.similarity);
  const min = similarities.length > 0 ? Math.min(...similarities) : 0;
  const max = similarities.length > 0 ? Math.max(...similarities) : 0;
  const span = max - min;

  const combined = new Map<string, HybridMatch>();
  for (const hit of keyword.hits) {
    combined.set(hit.id, {
      listingId: hit.id,
      score: keywordWeight * hit.score,
      keywordScore: hit.score,
      semanticScore: 0,
    });
  }
  for (const match of semantic) {
    const normalized = span > 0 ? (match.similarity - min) / span : 1;
    const existing = combined.get(match.listingId);
    const semanticScore = normalized;
    if (existing) {
      existing.semanticScore = semanticScore;
      existing.score = keywordWeight * existing.keywordScore + semanticWeight * semanticScore;
    } else {
      combined.set(match.listingId, {
        listingId: match.listingId,
        score: semanticWeight * semanticScore,
        keywordScore: 0,
        semanticScore,
      });
    }
  }

  return [...combined.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.listingId.localeCompare(b.listingId),
    )
    .slice(0, limit);
}

/**
 * Facet-filter-aware semantic search: runs semantic ranking, then enforces the
 * exact facet predicate at the document level (loads full documents by id).
 * Used by visual search to scope tag-derived neighbors to structured filters.
 */
export async function filteredSemanticSearch(
  prisma: PrismaClient,
  embedding: EmbeddingAdapter,
  query: { text: string; limit?: number; filters?: ListingFilters },
): Promise<{ match: SemanticMatch; document: ListingSearchDocument }[]> {
  const candidates = await semanticSearchListings(prisma, embedding, {
    text: query.text,
    limit: (query.limit ?? 10) * 5,
  });
  if (candidates.length === 0) return [];

  const now = new Date();
  const graphs = await prisma.listing.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.listingId) } },
    ...listingGraphArgs,
  });
  const documents = new Map(
    graphs.map((graph) => [graph.id, listingGraphToDocument(graph, now)]),
  );

  const results: { match: SemanticMatch; document: ListingSearchDocument }[] = [];
  for (const candidate of candidates) {
    const document = documents.get(candidate.listingId);
    if (!document) continue;
    if (query.filters && !matchesFilters(document, query.filters)) continue;
    results.push({ match: candidate, document });
    if (results.length >= (query.limit ?? 10)) break;
  }
  return results;
}
