import { MeiliSearch, type Index } from "meilisearch";
import { toMeilisearchFilter } from "./filtering";
import { tierBoost, listingGraphToDocument } from "./facets";
import type { ListingGraph } from "./listing-graph";
import type {
  ListingSearchDocument,
  ListingSearchIndex,
  ListingSearchQuery,
  ListingSearchResponse,
} from "./types";

/**
 * The real backend behind the Search adapter seam. Deployments opt in with
 * MEILISEARCH_HOST; without it the deterministic mock serves (mock-first,
 * zero keys). Outages degrade through the Postgres fallback — discovery
 * never 500s (see discovery.ts).
 */

const DEFAULT_INDEX = "listings";

type MeiliListingHit = ListingSearchDocument & {
  _rankingScore?: number;
};

export type MeilisearchConfig = {
  host: string;
  apiKey?: string;
  indexName: string;
};

export function meilisearchConfigFromEnv(
  env: Record<string, string | undefined>,
): MeilisearchConfig | null {
  const host = env["MEILISEARCH_HOST"];
  if (!host) return null;
  return {
    host,
    apiKey: env["MEILISEARCH_API_KEY"],
    indexName: env["MEILISEARCH_INDEX"] ?? DEFAULT_INDEX,
  };
}

export class MeilisearchListingSearch implements ListingSearchIndex {
  readonly #client: MeiliSearch;
  readonly #indexName: string;

  constructor(config: MeilisearchConfig) {
    this.#client = new MeiliSearch({ host: config.host, apiKey: config.apiKey });
    this.#indexName = config.indexName;
  }

  #index(): Index<ListingSearchDocument> {
    return this.#client.index<ListingSearchDocument>(this.#indexName);
  }

  /** Create the index and apply facet/filter/ranking settings idempotently. */
  async ensureIndex(): Promise<void> {
    await this.#client.createIndex(this.#indexName, { primaryKey: "id" });
    await this.#index().updateSettings({
      searchableAttributes: ["title", "body"],
      // The ten facet groups plus numeric/boolean filter fields.
      filterableAttributes: [
        "categoryFamily",
        "format",
        "material",
        "sizeBand",
        "moqBand",
        "priceBand",
        "leadTimeBand",
        "city",
        "country",
        "certifications",
        "sustainability",
        "printMethods",
        "verificationTier",
        "booleanFlags",
        "featured",
        "priceCents",
        "moqQty",
        "leadTimeDays",
      ],
      sortableAttributes: ["priceCents", "leadTimeDays", "verificationRank", "featured"],
      rankingRules: [
        "words",
        "typo",
        "proximity",
        "attribute",
        "sort",
        "exactness",
        "featured:desc",
        "verificationRank:desc",
      ],
    });
  }

  /** Upsert documents, creating the index and settings on first sync. */
  async upsert(documents: ListingSearchDocument[]): Promise<void> {
    await this.ensureIndex();
    // _geo is Meilisearch's reserved geopoint field; map from document geo.
    await this.#index().addDocuments(
      documents.map((doc) => ({
        ...doc,
        _geo: doc.geo ? { lat: doc.geo.latitude, lng: doc.geo.longitude } : undefined,
      })),
      { primaryKey: "id" },
    );
  }

  async search(query: ListingSearchQuery): Promise<ListingSearchResponse> {
    const result = await this.#index().search(query.q, {
      filter: toMeilisearchFilter(query.filters),
      sort: toMeilisearchSort(query.sort),
      limit: query.limit ?? 10,
      offset: query.offset ?? 0,
      facets: ["*"],
      showRankingScore: true,
    });

    return {
      hits: result.hits.map((hit) => {
        const doc = hit as MeiliListingHit;
        return {
          id: doc.id,
          score: doc._rankingScore ?? tierBoost(doc),
          document: doc,
        };
      }),
      total: result.estimatedTotalHits ?? result.hits.length,
      facetCounts: (result.facetDistribution ?? {}) as ListingSearchResponse["facetCounts"],
      source: "search-index",
    };
  }
}

function toMeilisearchSort(sort: ListingSearchQuery["sort"]): string[] | undefined {
  switch (sort) {
    case "price-asc":
      return ["priceCents:asc"];
    case "price-desc":
      return ["priceCents:desc"];
    case "lead-time-asc":
      return ["leadTimeDays:asc"];
    default:
      return undefined; // relevance — ranking rules decide
  }
}

/** Build search documents from loaded listing graphs (index-sync callers). */
export function documentsFromGraphs(
  graphs: ListingGraph[],
  now: Date = new Date(),
): ListingSearchDocument[] {
  return graphs.map((graph) => listingGraphToDocument(graph, now));
}
