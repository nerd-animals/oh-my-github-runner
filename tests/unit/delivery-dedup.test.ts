import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeliveryDedupCache } from "../../src/infra/webhook/delivery-dedup.js";

describe("DeliveryDedupCache", () => {
  test("first call returns false (not seen), repeat returns true", () => {
    const cache = new DeliveryDedupCache({ ttlMs: 60_000 });

    assert.equal(cache.markSeen("abc"), false);
    assert.equal(cache.markSeen("abc"), true);
    assert.equal(cache.markSeen("abc"), true);
  });

  test("different ids are tracked independently", () => {
    const cache = new DeliveryDedupCache({ ttlMs: 60_000 });

    assert.equal(cache.markSeen("a"), false);
    assert.equal(cache.markSeen("b"), false);
    assert.equal(cache.markSeen("a"), true);
    assert.equal(cache.markSeen("b"), true);
  });

  test("entries expire after the TTL", () => {
    let now = 0;
    const cache = new DeliveryDedupCache({ ttlMs: 1000, now: () => now });

    cache.markSeen("a");
    now = 999;
    assert.equal(cache.markSeen("a"), true);
    now = 1001;
    assert.equal(cache.markSeen("a"), false);
  });

  test("evicts the oldest entry when over the maxEntries cap", () => {
    let now = 0;
    const cache = new DeliveryDedupCache({
      ttlMs: 60_000,
      maxEntries: 2,
      now: () => now,
    });

    cache.markSeen("a");
    now = 1;
    cache.markSeen("b");
    now = 2;
    cache.markSeen("c");

    assert.equal(cache.size(), 2);
    assert.equal(cache.markSeen("a"), false);
  });
});
