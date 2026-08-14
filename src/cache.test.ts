import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCacheStorage,
  dedupeThreadLoad,
  readSnapshotCache,
  readThreadCache,
  readUiCache,
  resetCacheForTests,
  sanitizeSnapshot,
  writeSnapshotCache,
  writeThreadCache,
  writeUiCache,
} from "./cache";
import type { Snapshot } from "./types";

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

const snapshot = (partial: Partial<Snapshot> = {}): Snapshot => ({
  providers: [],
  threads: [],
  approvals: [{ id: "a1", providerId: "p", request: { method: "x", params: {} } }],
  ...partial,
});

test("sanitizeSnapshot drops stale approvals before caching", () => {
  const next = sanitizeSnapshot(snapshot());
  assert.deepEqual(next.approvals, []);
});

test("snapshot cache hydrates from session storage", () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  writeSnapshotCache(
    snapshot({
      threads: [
        {
          id: "t1",
          providerId: "p",
          name: "会话",
          preview: "hi",
          cwd: "/tmp",
          model: "gpt",
          status: "idle",
          updatedAt: 1,
        },
      ],
    }),
  );
  resetCacheForTests();
  const cached = readSnapshotCache();
  assert.equal(cached?.threads[0]?.id, "t1");
  assert.deepEqual(cached?.approvals, []);
});

test("thread cache returns the last write and dedupes inflight loads", async () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  writeThreadCache("p:t1", { turns: [1] });
  assert.deepEqual(readThreadCache("p:t1"), { turns: [1] });

  let calls = 0;
  const first = dedupeThreadLoad("p:t2", async () => {
    calls += 1;
    return { turns: [2] };
  });
  const second = dedupeThreadLoad("p:t2", async () => {
    calls += 1;
    return { turns: [99] };
  });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { turns: [2] });
  assert.deepEqual(b, { turns: [2] });
  assert.deepEqual(readThreadCache("p:t2"), { turns: [2] });
});

test("ui cache stores expanded projects and query", () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  writeUiCache({ expandedProjects: ["/tmp/app"], query: "slam" });
  resetCacheForTests();
  assert.deepEqual(readUiCache(), {
    expandedProjects: ["/tmp/app"],
    query: "slam",
  });
});
