export interface DeliveryDedupCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class DeliveryDedupCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DeliveryDedupCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns true if the id has already been seen within the TTL.
   * Otherwise records the id and returns false.
   */
  markSeen(id: string): boolean {
    const now = this.now();
    this.evictExpired(now);

    const expiry = this.entries.get(id);

    if (expiry !== undefined && expiry > now) {
      return true;
    }

    if (expiry !== undefined) {
      this.entries.delete(id);
    }

    this.entries.set(id, now + this.ttlMs);

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;

      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    return false;
  }

  size(): number {
    return this.entries.size;
  }

  private evictExpired(now: number): void {
    for (const [id, expiry] of this.entries) {
      if (expiry > now) {
        return;
      }

      this.entries.delete(id);
    }
  }
}
