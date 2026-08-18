import test from "node:test";
import assert from "node:assert/strict";
import {
  compactSnapshot,
  configureCacheStorage,
  dedupeThreadLoad,
  hasSidebarData,
  readSnapshotCache,
  reconcileSnapshot,
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
  approvals: [
    { id: "a1", providerId: "p", request: { method: "x", params: {} } },
  ],
  ...partial,
});

test("sanitizeSnapshot drops stale approvals before caching", () => {
  const next = sanitizeSnapshot(snapshot());
  assert.deepEqual(next.approvals, []);
});

test("empty snapshots are not treated as sidebar data", () => {
  assert.equal(hasSidebarData(snapshot()), false);
  assert.equal(
    hasSidebarData(
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
    ),
    true,
  );
});

test("loading agent snapshots retain cached threads until history is ready", () => {
  const cached = snapshot({
    threads: [
      {
        agentId: "codex",
        id: "cached",
        providerId: "local",
        cwd: "/work",
        preview: "cached",
        model: "gpt-test",
        status: "idle",
        updatedAt: 1,
      },
    ],
  });
  const loading = snapshot({
    threads: [
      {
        ...cached.threads[0],
        providerId: "remapped",
        preview: "fresh",
      },
    ],
    agents: [
      {
        id: "codex",
        name: "Codex",
        available: true,
        online: false,
        historyStatus: "loading",
        capabilities: {} as any,
      },
    ],
  });
  const reconciled = reconcileSnapshot(cached, loading);
  assert.equal(reconciled.threads.length, 1);
  assert.equal(reconciled.threads[0]?.providerId, "remapped");

  const ready = {
    ...loading,
    agents: loading.agents?.map((agent) => ({
      ...agent,
      historyStatus: "ready" as const,
    })),
  };
  assert.equal(
    reconcileSnapshot(cached, { ...ready, threads: [] }).threads.length,
    0,
  );
});

test("writeSnapshotCache ignores empty snapshots so a later load cannot wipe the library", () => {
  resetCacheForTests();
  const store = new MemoryStorage();
  configureCacheStorage(store);
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
  writeSnapshotCache(snapshot());
  resetCacheForTests();
  configureCacheStorage(store);
  assert.equal(readSnapshotCache()?.threads[0]?.id, "t1");
});

test("snapshot cache hydrates from durable storage", () => {
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

test("compactSnapshot keeps only sidebar fields", () => {
  const next = compactSnapshot(
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
          lastError: "secret",
          tokenUsage: { used: 9 },
        },
      ],
    }),
  );
  assert.equal(next.threads[0]?.lastError, undefined);
  assert.equal(next.threads[0]?.tokenUsage, undefined);
});

test("compactSnapshot keeps runtimeWsl so the WSL cwd button can hydrate", () => {
  const next = compactSnapshot(
    snapshot({
      runtime: {
        online: true,
        starting: false,
        remoteUrl: "ws://127.0.0.1:1",
        runtimeWsl: true,
      },
    }),
  );
  assert.equal(next.runtime?.runtimeWsl, true);
});

test("compactSnapshot keeps public Agent profiles for session labels", () => {
  const next = compactSnapshot(
    snapshot({
      agentProfiles: [
        {
          id: "claude-cc-relay",
          agentId: "claude",
          name: "Relay",
          enabled: true,
        },
      ],
    }),
  );
  assert.equal(next.agentProfiles?.[0]?.name, "Relay");
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

test("ui cache restores expanded projects but not the search box", () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  writeUiCache({ expandedProjects: ["/tmp/app"], query: "slam" });
  resetCacheForTests();
  assert.deepEqual(readUiCache(), {
    expandedProjects: ["/tmp/app"],
    query: "",
  });
});
