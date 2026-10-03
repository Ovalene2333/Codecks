import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCacheStorage,
  readThreadEtag,
  resetCacheForTests,
  writeThreadCache,
  writeThreadEtag,
} from "../cache";
import {
  fetchThreadFull,
  shouldKeepLoadedThread,
  shouldSurfaceThreadLoadError,
} from "./thread-load.ts";

test("thread load errors stay silent when turns are already on screen", () => {
  assert.equal(shouldSurfaceThreadLoadError({ turns: [{ id: "t1" }] }), false);
  assert.equal(shouldSurfaceThreadLoadError({ turns: [] }), true);
  assert.equal(shouldSurfaceThreadLoadError({}), true);
  assert.equal(shouldSurfaceThreadLoadError(undefined), true);
});

test("an empty in-progress response does not erase a cached transcript", () => {
  assert.equal(
    shouldKeepLoadedThread({ turns: [{ id: "previous" }] }, { turns: [] }),
    true,
  );
  assert.equal(shouldKeepLoadedThread({ turns: [] }, { turns: [] }), false);
  assert.equal(
    shouldKeepLoadedThread(
      { turns: [{ id: "previous" }] },
      { turns: [{ id: "next" }] },
    ),
    false,
  );
});

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

const fakeResponse = (status: number, body?: any, etag?: string) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "etag" ? (etag ?? null) : null,
    },
    json: async () => body,
  }) as any;

async function withFetch(
  handler: (init?: RequestInit) => Promise<any> | any,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) =>
    handler(init)) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    configureCacheStorage(undefined);
    resetCacheForTests();
  }
}

test("fetchThreadFull reuses the cached transcript on 304", async () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  writeThreadCache("k1", { turns: [{ id: "t1" }] });
  writeThreadEtag("k1", 'W/"abc"');
  const sent: Array<Record<string, string>> = [];
  await withFetch(
    (init) => {
      sent.push((init?.headers || {}) as Record<string, string>);
      return fakeResponse(304);
    },
    async () => {
      const data: any = await fetchThreadFull({ id: "t1" }, "k1");
      assert.equal(data.turns[0].id, "t1");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]["If-None-Match"], 'W/"abc"');
    },
  );
});

test("fetchThreadFull stores the response ETag for later revalidations", async () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  const sent: Array<Record<string, string>> = [];
  await withFetch(
    (init) => {
      sent.push((init?.headers || {}) as Record<string, string>);
      return fakeResponse(200, { turns: [{ id: "t2" }] }, 'W/"e1"');
    },
    async () => {
      const data: any = await fetchThreadFull({ id: "t2" }, "k2");
      assert.equal(data.turns[0].id, "t2");
      assert.equal(readThreadEtag("k2"), 'W/"e1"');
      assert.equal(sent[0]["If-None-Match"], undefined);
    },
  );
});

test("fetchThreadFull does not revalidate against a tail-only cached copy", async () => {
  resetCacheForTests();
  const store = new MemoryStorage();
  configureCacheStorage(store);
  const turns = Array.from({ length: 60 }, (_, index) => ({ id: `t${index}` }));
  writeThreadCache("k4", { turns });
  writeThreadEtag("k4", 'W/"full"');
  // 刷新页面：内存清空，落盘副本只剩尾部。
  resetCacheForTests();
  configureCacheStorage(store);
  const sent: Array<Record<string, string>> = [];
  await withFetch(
    (init) => {
      sent.push((init?.headers || {}) as Record<string, string>);
      return fakeResponse(200, { turns }, 'W/"full"');
    },
    async () => {
      const data: any = await fetchThreadFull({ id: "t4" }, "k4");
      assert.equal(data.turns.length, 60);
      assert.equal(sent[0]["If-None-Match"], undefined);
    },
  );
});

test("fetchThreadFull retries unconditionally if the cache is evicted mid-flight", async () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  writeThreadCache("k3", { turns: [{ id: "t3" }] });
  writeThreadEtag("k3", 'W/"stale"');
  const sent: Array<Record<string, string> | undefined> = [];
  await withFetch(
    (init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      sent.push(headers);
      if (headers?.["If-None-Match"]) {
        // 请求在途时缓存体被淘汰：服务端回 304 但本地已无可复用数据。
        configureCacheStorage(new MemoryStorage());
        resetCacheForTests();
        return fakeResponse(304);
      }
      return fakeResponse(200, { turns: [{ id: "t3b" }] }, 'W/"fresh"');
    },
    async () => {
      const data: any = await fetchThreadFull({ id: "t3" }, "k3");
      assert.equal(data.turns[0].id, "t3b");
      assert.equal(sent.length, 2);
      assert.equal(sent[0]?.["If-None-Match"], 'W/"stale"');
      assert.equal(sent[1]?.["If-None-Match"], undefined);
      assert.equal(readThreadEtag("k3"), 'W/"fresh"');
    },
  );
});
