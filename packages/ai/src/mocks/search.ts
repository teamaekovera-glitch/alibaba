import type { SearchAdapter, SearchDocument, SearchHit, SearchQuery } from "../types";

/** In-memory Meilisearch stand-in: token AND-match over title/body with
 * optional facet filters, deterministic score-then-id ordering. */
export class MockSearchAdapter implements SearchAdapter {
  readonly #indexes = new Map<string, Map<string, SearchDocument>>();

  async index(indexName: string, documents: SearchDocument[]): Promise<void> {
    const idx = this.#indexFor(indexName);
    for (const doc of documents) {
      idx.set(doc.id, doc);
    }
  }

  async query(indexName: string, query: SearchQuery): Promise<SearchHit[]> {
    const idx = this.#indexFor(indexName);
    const tokens = query.q.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const hits: SearchHit[] = [];
    for (const doc of idx.values()) {
      if (!matchesFilters(doc, query.filters)) {
        continue;
      }
      const score = tokens.length === 0 ? 0 : matchRatio(doc, tokens);
      if (score > 0) {
        hits.push({ id: doc.id, score, document: doc });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return hits.slice(0, query.limit ?? 10);
  }

  /** Test helper: reset all indexes. */
  clear(): void {
    this.#indexes.clear();
  }

  #indexFor(indexName: string): Map<string, SearchDocument> {
    let idx = this.#indexes.get(indexName);
    if (!idx) {
      idx = new Map();
      this.#indexes.set(indexName, idx);
    }
    return idx;
  }
}

function matchesFilters(doc: SearchDocument, filters: Record<string, string> | undefined): boolean {
  if (!filters) {
    return true;
  }
  return Object.entries(filters).every(([key, value]) => doc.attributes?.[key] === value);
}

function matchRatio(doc: SearchDocument, tokens: string[]): number {
  const haystack = `${doc.title} ${doc.body ?? ""}`.toLowerCase();
  const matched = tokens.filter((t) => haystack.includes(t)).length;
  return matched / tokens.length;
}
