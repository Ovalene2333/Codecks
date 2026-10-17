import test from "node:test";
import assert from "node:assert/strict";
import { configureCacheStorage } from "./cache";
import { SwrCache } from "./swr-cache";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

test("swr cache persists entries and hydrates them after a reload", () => {
  const store = new MemoryStorage();
  configureCacheStorage(store);
  try {
    const cache = new SwrCache<string[]>({
      persist: "test-list",
      ttlMs: 60_000,
      maxEntries: 4,
    });
    cache.set("a", ["x"]);
    cache.resetForTests();
    const entry = cache.peek("a");
    assert.deepEqual(entry?.value, ["x"]);
    assert.equal(cache.isFresh(entry), true);
  } finally {
    configureCacheStorage(undefined);
  }
});

test("swr cache evicts the least recently used entry", () => {
  configureCacheStorage(null);
  try {
    const cache = new SwrCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.peek("a");
    cache.set("c", 3);
    assert.equal(cache.peek("b"), undefined);
    assert.equal(cache.peek("a")?.value, 1);
    assert.equal(cache.peek("c")?.value, 3);
  } finally {
    configureCacheStorage(undefined);
  }
});

test("swr cache keeps oversized entries in memory only", () => {
  const store = new MemoryStorage();
  configureCacheStorage(store);
  try {
    const cache = new SwrCache<string>({
      persist: "test-big",
      ttlMs: 60_000,
      maxEntries: 4,
      maxPersistChars: 100,
    });
    cache.set("small", "ok");
    cache.set("big", "x".repeat(500));
    assert.equal(cache.peek("big")?.value.length, 500);
    cache.resetForTests();
    assert.equal(cache.peek("big"), undefined);
    assert.equal(cache.peek("small")?.value, "ok");
  } finally {
    configureCacheStorage(undefined);
  }
});

test("swr cache dedupes concurrent loads and treats ttl 0 as always stale", async () => {
  configureCacheStorage(null);
  try {
    const cache = new SwrCache<number>({ ttlMs: 0, maxEntries: 4 });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return 7;
    };
    const [a, b] = await Promise.all([
      cache.load("k", fetcher),
      cache.load("k", fetcher),
    ]);
    assert.equal(calls, 1);
    assert.equal(a, 7);
    assert.equal(b, 7);
    assert.equal(cache.isFresh(cache.peek("k")), false);
  } finally {
    configureCacheStorage(undefined);
  }
});
