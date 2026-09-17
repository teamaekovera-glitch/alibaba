import type { StorageAdapter, StoredObject } from "../types";

const MOCK_HOST = "https://mock-r2.internal";

/** In-memory R2/S3 stand-in: put/get/delete round-trips with deterministic
 * signed URLs (no randomness, fixed expiry echo). */
export class MockStorageAdapter implements StorageAdapter {
  readonly #objects = new Map<string, StoredObject>();

  async put(key: string, body: Uint8Array | string, contentType?: string) {
    const stored: StoredObject = {
      key,
      body: typeof body === "string" ? new TextEncoder().encode(body) : body,
      contentType,
    };
    this.#objects.set(key, stored);
    return { key, url: `${MOCK_HOST}/${key}` };
  }

  async get(key: string): Promise<StoredObject | undefined> {
    const stored = this.#objects.get(key);
    return stored ? { ...stored, body: new Uint8Array(stored.body) } : undefined;
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  async signedUrl(key: string, expiresIn = 3600): Promise<string> {
    return `${MOCK_HOST}/${key}?expires=${expiresIn}`;
  }
}
