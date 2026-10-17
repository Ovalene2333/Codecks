import test from "node:test";
import assert from "node:assert/strict";
import {
  cachedThreadKeys,
  compactSnapshot,
  configureCacheStorage,
  dedupeThreadLoad,
  hasSidebarData,
  isPartialThread,
  PARTIAL_KEY,
  readCompleteThreadCache,
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

test("standby fallback agents do not keep their cached sessions alive", () => {
  const thread = (agentId: string, id: string) => ({
    agentId,
    id,
    providerId: `${agentId}-current`,
    cwd: "/work",
    preview: id,
    name: id,
    model: "default",
    status: "idle" as const,
    updatedAt: 1,
  });
  const cached = snapshot({
    threads: [thread("claude", "a"), thread("claude-acp", "a")],
  });
  const agent = (
    id: string,
    extra: Partial<NonNullable<Snapshot["agents"]>[number]>,
  ) => ({
    id,
    name: id,
    available: true,
    online: true,
    capabilities: {} as any,
    ...extra,
  });
  const incoming = (acp: Partial<NonNullable<Snapshot["agents"]>[number]>) =>
    snapshot({
      threads: [thread("claude", "a")],
      agents: [
        agent("claude", { historyStatus: "ready" }),
        agent("claude-acp", { fallbackFor: "claude", ...acp }),
      ],
    });

  // 备选 agent 历史读取失败也不例外：服务端在待命，缓存里的重复副本必须清掉。
  for (const historyStatus of ["error", "loading", "cached"] as const) {
    const reconciled = reconcileSnapshot(
      cached,
      incoming({ standby: true, historyStatus }),
    );
    assert.deepEqual(
      reconciled.threads.map((item) => `${item.agentId}:${item.id}`),
      ["claude:a"],
      historyStatus,
    );
  }

  // 不待命（主 agent 不可用）时沿用原有规则：历史没就绪就保留缓存。
  const notStandby = reconcileSnapshot(
    cached,
    incoming({ historyStatus: "loading" }),
  );
  assert.deepEqual(
    notStandby.threads.map((item) => `${item.agentId}:${item.id}`).sort(),
    ["claude-acp:a", "claude:a"],
  );
});

test("a disabled agent does not keep cached sessions on screen", () => {
  const thread = (agentId: string, id: string) => ({
    agentId,
    id,
    providerId: `${agentId}-current`,
    cwd: "/work",
    preview: id,
    name: id,
    model: "default",
    status: "idle" as const,
    updatedAt: 1,
  });
  const cached = snapshot({
    threads: [thread("codex", "c1"), thread("kimi", "k1")],
  });
  const agent = (id: string, extra: object = {}) => ({
    id,
    name: id,
    available: true,
    online: true,
    capabilities: {} as any,
    ...extra,
  });
  const keys = (next: Snapshot) =>
    next.threads.map((item) => `${item.agentId}:${item.id}`).sort();

  // 停用后服务端不再下发它的会话；历史状态没就绪也不能把旧缓存留下。
  const disabled = reconcileSnapshot(
    cached,
    snapshot({
      threads: [thread("codex", "c1")],
      agents: [
        agent("codex", { historyStatus: "ready" }),
        agent("kimi", { enabled: false, online: false }),
      ],
    }),
  );
  assert.deepEqual(keys(disabled), ["codex:c1"]);

  // 没停用、只是历史还在加载：沿用原有规则，缓存的会话继续显示。
  const loading = reconcileSnapshot(
    cached,
    snapshot({
      threads: [thread("codex", "c1")],
      agents: [
        agent("codex", { historyStatus: "ready" }),
        agent("kimi", { historyStatus: "loading" }),
      ],
    }),
  );
  assert.deepEqual(keys(loading), ["codex:c1", "kimi:k1"]);
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

test("compactSnapshot keeps first-screen usage but not raw error text", () => {
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
  // 首页用量合计/上下文占比要随缓存秒出。
  assert.deepEqual(next.threads[0]?.tokenUsage, { used: 9 });
});

test("compactSnapshot keeps the monitor's first-screen data", () => {
  const next = compactSnapshot(
    snapshot({
      agents: [
        {
          id: "codex",
          name: "Codex",
          available: true,
          online: true,
          capabilities: {} as any,
        },
      ],
      providers: [
        {
          id: "p",
          name: "P",
          kind: "custom",
          color: "#000",
          hasApiKey: true,
          enabled: true,
          online: false,
          error: "连接失败",
          baseUrl: "https://example.invalid",
        },
      ],
      activities: [
        {
          agentId: "codex",
          threadId: "t1",
          lastEventAt: 1,
          step: { startedAt: 1, item: { id: "i", type: "x", command: "x".repeat(1_000) } },
          lastTurn: { startedAt: 1, endedAt: 2, status: "completed", reply: "y".repeat(1_000) },
        },
      ],
      wakeDeliveries: [
        {
          id: "d1",
          code: "c",
          status: "dead",
          agentId: "codex",
          threadId: "t1",
          attempts: 3,
          createdAt: 1,
          updatedAt: 2,
          preview: "p",
        },
      ],
      tools: [
        { id: "git", name: "Git", description: "", icon: "git", available: true },
      ],
      runtime: {
        online: true,
        starting: false,
        remoteUrl: "",
        rateLimits: { primary: { usedPercent: 10 } } as any,
        account: { planType: "pro", email: "user@example.invalid" },
      },
    }),
  );
  assert.equal(next.agents?.[0]?.id, "codex");
  assert.equal(next.providers[0]?.error, "连接失败");
  assert.equal(next.providers[0]?.baseUrl, undefined);
  assert.equal(next.activities?.[0]?.step?.item.command?.length, 300);
  assert.equal(next.activities?.[0]?.lastTurn?.reply?.length, 240);
  assert.equal(next.wakeDeliveries?.[0]?.id, "d1");
  assert.equal(next.tools?.[0]?.id, "git");
  assert.deepEqual(next.runtime?.rateLimits, { primary: { usedPercent: 10 } });
  assert.equal(next.runtime?.account?.planType, "pro");
  assert.equal(next.runtime?.account?.email, undefined);
  assert.deepEqual(next.approvals, []);
});

test("pending message deliveries hydrate from disk before a live snapshot arrives", () => {
  resetCacheForTests();
  const store = new MemoryStorage();
  configureCacheStorage(store);
  const deliveries: NonNullable<Snapshot["messageDeliveries"]> = [{
    id: "queued-message", agentId: "claude", threadId: "t1",
    mode: "queue", status: "queued", preview: "待处理的下一条指令",
    text: "待处理的下一条指令".repeat(100), imageCount: 1,
    createdAt: 1, updatedAt: 1,
  }, {
    id: "failed-feedback", agentId: "claude", threadId: "t1",
    mode: "feedback", status: "failed", preview: "尚未发送的反馈",
    createdAt: 2, updatedAt: 3, error: "未能确认任务结束", canRetry: true,
  }];
  writeSnapshotCache(snapshot({
    threads: [{
      id: "t1", agentId: "claude", providerId: "local", cwd: "/work",
      preview: "", model: "test", status: "running", updatedAt: 1,
    }],
    messageDeliveries: deliveries,
  }));
  resetCacheForTests();
  configureCacheStorage(store);
  assert.deepEqual(readSnapshotCache()?.messageDeliveries, deliveries);
  resetCacheForTests();
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

test("compactSnapshot keeps runtime context settings for the settings form", () => {
  const next = compactSnapshot(
    snapshot({
      runtime: {
        online: true,
        starting: false,
        remoteUrl: "ws://127.0.0.1:1",
        modelConfig: {
          modelContextWindow: 1_000_000,
          modelAutoCompactTokenLimit: 900_000,
        },
      },
    }),
  );
  assert.deepEqual(next.runtime?.modelConfig, {
    modelContextWindow: 1_000_000,
    modelAutoCompactTokenLimit: 900_000,
  });
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

test("long transcripts persist only their tail, marked as partial", () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  const turns = Array.from({ length: 100 }, (_, index) => ({ id: `t${index}` }));
  writeThreadCache("p:long", { id: "long", turns });
  // 内存里仍是全文，可当 304 复用体。
  assert.equal((readThreadCache<any>("p:long")).turns.length, 100);
  assert.ok(readCompleteThreadCache("p:long"));
  // 模拟刷新页面：内存清空，只剩落盘的尾部。
  resetCacheForTests();
  const tail = readThreadCache<any>("p:long");
  assert.equal(tail.turns.length, 40);
  assert.equal(tail.turns[0].id, "t60");
  assert.equal(tail[PARTIAL_KEY], 60);
  assert.equal(isPartialThread(tail), true);
  assert.equal(readCompleteThreadCache("p:long"), null);
  assert.ok(cachedThreadKeys().has("p:long"));
});

test("an oversized single turn is kept in memory but not persisted", () => {
  resetCacheForTests();
  const store = new MemoryStorage();
  configureCacheStorage(store);
  writeThreadCache("p:huge", { turns: [{ text: "x".repeat(500_000) }] });
  assert.ok(readThreadCache("p:huge"));
  assert.equal(store.getItem("codex-deck:thread:v1:p:huge"), null);
  assert.equal(cachedThreadKeys().has("p:huge"), true);
  resetCacheForTests();
  assert.equal(readThreadCache("p:huge"), null);
  assert.equal(cachedThreadKeys().has("p:huge"), false);
});

test("the in-memory thread cache evicts the least recently used entries", () => {
  resetCacheForTests();
  configureCacheStorage(null);
  for (let index = 0; index < 8; index += 1)
    writeThreadCache(`p:${index}`, { turns: [index] });
  // 读一次 p:0，让它变成最近使用；再写一条就该淘汰 p:1。
  assert.ok(readThreadCache("p:0"));
  writeThreadCache("p:8", { turns: [8] });
  const kept = [...cachedThreadKeys()];
  assert.equal(kept.length, 8);
  assert.ok(kept.includes("p:0"));
  assert.ok(kept.includes("p:8"));
  assert.equal(kept.includes("p:1"), false);
  configureCacheStorage(undefined);
});

test("a fresh thread load waits for an older response before reading reverted history", async () => {
  resetCacheForTests();
  configureCacheStorage(new MemoryStorage());
  let finishOld!: (value: { turns: number[] }) => void;
  const old = dedupeThreadLoad(
    "p:reverted",
    () =>
      new Promise<{ turns: number[] }>((resolve) => {
        finishOld = resolve;
      }),
  );
  let freshCalls = 0;
  const fresh = dedupeThreadLoad(
    "p:reverted",
    async () => {
      freshCalls += 1;
      return { turns: [] };
    },
    true,
  );
  assert.equal(freshCalls, 0);
  finishOld({ turns: [1] });
  await old;
  assert.deepEqual(await fresh, { turns: [] });
  assert.equal(freshCalls, 1);
  assert.deepEqual(readThreadCache("p:reverted"), { turns: [] });
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

test("ui cache drops the retired tiled view mode", () => {
  resetCacheForTests();
  const store = new MemoryStorage();
  configureCacheStorage(store);
  store.setItem(
    "codex-deck:ui:v2",
    JSON.stringify({ expandedProjects: ["/tmp/app"], viewMode: "tiled" }),
  );
  assert.deepEqual(readUiCache(), {
    expandedProjects: ["/tmp/app"],
    query: "",
  });
  writeUiCache(readUiCache());
  assert.equal(store.getItem("codex-deck:ui:v2")?.includes("viewMode"), false);
});
