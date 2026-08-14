import test from "node:test";
import assert from "node:assert/strict";
import { CodexManager } from "./manager.js";
import { compileRuntimeProvider } from "./provider-config.js";

test("thread/list asks for every model provider so CCS default does not hide history", async () => {
  const provider = { id: "local", model: "m", kind: "local-profile" };
  const manager = new CodexManager(
    {
      runtimeProviders: () => [],
      runtimeProfile: () => provider,
      listPublic: () => [],
      get: () => provider,
    } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return {
        data: params.archived
          ? []
          : [
              {
                id: "hist",
                cwd: "\\\\?\\D:\\Code\\demo",
                preview: "old",
                modelProvider: "custom",
              },
            ],
      };
    },
  });

  await manager.refreshAll();
  assert.equal(calls[0].method, "thread/list");
  assert.deepEqual(calls[0].params.modelProviders, []);
  assert.equal(calls[0].params.archived, false);
  assert.equal(manager.listThreads().length, 1);
  assert.equal(manager.listThreads()[0].id, "hist");
});

test("a failed thread/list does not wipe already loaded history", async () => {
  const provider = { id: "local", model: "m" };
  const manager = new CodexManager(
    { listPublic: () => [] } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(provider, {
    id: "kept",
    cwd: "D:\\Code\\demo",
    preview: "already visible",
  });
  manager.ensure = async () => ({
    request: async () => {
      throw new Error("thread/list 请求超时");
    },
  });

  await manager.refreshAll();
  assert.equal(manager.listThreads().length, 1);
  assert.equal(manager.listThreads()[0].id, "kept");
});

test("a real Codex thread has one identity independent of provider selection", () => {
  const manager = new CodexManager({} as any, "/tmp") as any;
  const providerA = { id: "wsl", model: "m" };
  const providerB = { id: "windows", model: "m" };
  manager.upsertThread(providerA, {
    id: "same",
    cwd: "/mnt/d/project",
    preview: "WSL",
  });
  manager.upsertThread(providerB, {
    id: "same",
    cwd: "D:\\project",
    preview: "Windows",
  });
  assert.equal(manager.listThreads().length, 1);
  assert.equal(manager.listThreads()[0].providerId, "windows");
});

test("applyProviderConfig refuses while a session is running", async () => {
  const manager = new CodexManager({ listPublic: () => [] } as any, "/tmp") as any;
  manager.upsertThread(
    { id: "local", model: "m" },
    { id: "busy", cwd: "D:\\demo", preview: "run" },
    "running",
  );
  assert.equal(manager.busyThreads().length, 1);
  await assert.rejects(
    () => manager.applyProviderConfig(),
    /仍有 1 个会话正在运行或等待审批/,
  );
});

test("concurrent provider requests share one app-server startup", async () => {
  const manager = new CodexManager({ get: () => ({}) } as any, "/tmp") as any;
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = { online: true };
  manager.startClient = async () => {
    starts += 1;
    await gate;
    return client;
  };

  const first = manager.ensure("provider");
  const second = manager.ensure("provider");
  assert.equal(starts, 1);
  release();
  assert.equal(await first, client);
  assert.equal(await second, client);
});

test("unmaterialized threads are read without turns until their first user message", async () => {
  const manager = new CodexManager({} as any, "/tmp") as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (params.includeTurns)
        throw new Error(
          "thread fresh is not materialized yet; includeTurns is unavailable before first user message",
        );
      return { thread: { id: "fresh", cwd: "/tmp/project" } };
    },
  });

  const thread = await manager.readThread("provider", "fresh");
  assert.equal(thread.id, "fresh");
  assert.deepEqual(calls, [
    {
      method: "thread/read",
      params: { threadId: "fresh", includeTurns: true },
    },
    {
      method: "thread/read",
      params: { threadId: "fresh", includeTurns: false },
    },
  ]);
});

test("empty rollout reads fall back to metadata like unmaterialized threads", async () => {
  const manager = new CodexManager({} as any, "/tmp") as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (params.includeTurns)
        throw new Error(
          "Failed to read thread: failed to read session metadata /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
        );
      return { thread: { id: "fresh", cwd: "/tmp/project" } };
    },
  });

  const thread = await manager.readThread("provider", "fresh");
  assert.equal(thread.id, "fresh");
  assert.deepEqual(
    calls.map((call) => call.params.includeTurns),
    [true, false],
  );
});

test("thread not found on read is explained without resuming", async () => {
  const manager = new CodexManager({} as any, "/tmp") as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      throw new Error("thread not found: abc");
    },
  });
  await assert.rejects(
    manager.readThread("provider", "abc"),
    /当前 Runtime 里没有这条会话/,
  );
  assert.deepEqual(calls, ["thread/read"]);
});

test("thread read errors unrelated to materialization are preserved", async () => {
  const manager = new CodexManager({} as any, "/tmp") as any;
  manager.ensure = async () => ({
    request: async () => {
      throw new Error("connection lost");
    },
  });
  await assert.rejects(
    manager.readThread("provider", "missing"),
    /connection lost/,
  );
});

test("new thread starts its first turn without trying to resume a missing rollout", async () => {
  const provider = {
    id: "provider",
    name: "OpenAI",
    kind: "local-profile",
    model: "m",
  };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "fresh", cwd: "/tmp/project" } };
      if (method === "thread/resume")
        throw new Error("no rollout found for thread id fresh");
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected request: ${method}`);
    },
  });

  await manager.createThread("provider", { cwd: "/tmp/project" });
  const result = await manager.sendTurn("provider", "fresh", "测试消息");
  await manager.sendTurn("provider", "fresh", "第二条消息");

  assert.equal(result.turn.id, "turn-1");
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["thread/start", "turn/start", "turn/start"],
  );
});

test("persisted thread is resumed before starting a new turn", async () => {
  const manager = new CodexManager(
    { get: () => ({ id: "provider", kind: "local-profile" }) } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      return method === "turn/start" ? { turn: { id: "turn-2" } } : {};
    },
  });

  await manager.sendTurn("provider", "persisted", "继续");
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
});

test("closed thread is resumed again before its next turn", async () => {
  const manager = new CodexManager(
    {
      get: () => ({
        id: "provider",
        name: "OpenAI",
        kind: "local-profile",
      }),
    } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      if (method === "thread/start")
        return { thread: { id: "fresh", cwd: "/tmp" } };
      return {};
    },
  });

  await manager.createThread("provider", { cwd: "/tmp" });
  manager.onNotification("provider", {
    method: "thread/closed",
    params: { threadId: "fresh" },
  });
  await manager.sendTurn("provider", "fresh", "重新加载");
  assert.deepEqual(calls, ["thread/start", "thread/resume", "turn/start"]);
});

test("failed turn exposes its error and a new turn clears it", () => {
  const manager = new CodexManager(
    { get: () => ({ id: "provider", model: "m" }) } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(
    { id: "provider", model: "m" },
    { id: "thread", cwd: "/tmp" },
  );

  manager.onNotification("provider", {
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: {
        status: "failed",
        error: {
          message: "refresh token was revoked",
          codexErrorInfo: "unauthorized",
        },
      },
    },
  });
  let thread = manager.listThreads()[0];
  assert.equal(thread.status, "error");
  assert.equal(thread.lastError, "refresh token was revoked");
  assert.equal(thread.errorCode, "unauthorized");

  manager.onNotification("provider", {
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "next" } },
  });
  thread = manager.listThreads()[0];
  assert.equal(thread.status, "running");
  assert.equal(thread.lastError, undefined);
  assert.equal(thread.errorCode, undefined);
});

test("non-retrying error notification is returned to the thread", () => {
  const manager = new CodexManager(
    { get: () => ({ id: "provider", model: "m" }) } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(
    { id: "provider", model: "m" },
    { id: "thread", cwd: "/tmp" },
  );
  manager.onNotification("provider", {
    method: "error",
    params: {
      threadId: "thread",
      willRetry: false,
      error: {
        message: "server unavailable",
        codexErrorInfo: "serverOverloaded",
      },
    },
  });
  assert.equal(manager.listThreads()[0].lastError, "server unavailable");
});

test("createThread forwards model and reasoning effort", async () => {
  const provider = {
    id: "provider",
    name: "OpenAI",
    kind: "local-profile",
    model: "fallback",
  };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "fresh", cwd: "/tmp/project" } };
      return {};
    },
  });
  await manager.createThread("provider", {
    cwd: "/tmp/project",
    model: "gpt-custom",
    reasoningEffort: "high",
    name: "任务",
  });
  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.model, "gpt-custom");
  assert.equal(calls[0].params.reasoningEffort, "high");
  assert.equal(manager.listThreads()[0].model, "gpt-custom");
});

test("archive and delete update the snapshot buckets", async () => {
  const provider = { id: "provider", model: "m" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      return {};
    },
  });
  manager.upsertThread(provider, { id: "one", cwd: "/tmp" });
  await manager.archiveThread("provider", "one");
  assert.equal(manager.listThreads().length, 0);
  assert.equal(manager.listArchivedThreads().length, 1);
  await manager.unarchiveThread("provider", "one");
  assert.equal(manager.listThreads().length, 1);
  await manager.deleteThread("provider", "one");
  assert.equal(manager.listThreads().length, 0);
  assert.deepEqual(calls, [
    "thread/archive",
    "thread/unarchive",
    "thread/delete",
  ]);
});

test("settings update is forwarded to a loaded thread", async () => {
  const provider = { id: "provider", model: "m" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
  });
  manager.loadedThreads.add("one");
  manager.upsertThread(provider, { id: "one", cwd: "/tmp", model: "old" });
  await manager.updateThreadSettings("provider", "one", { model: "new" });
  assert.equal(calls[0].method, "thread/settings/update");
  assert.equal(calls[0].params.model, "new");
  assert.equal(manager.listThreads()[0].model, "new");
});

test("sandbox settings are sent as sandboxPolicy objects, not kebab strings", async () => {
  const provider = { id: "provider", model: "m" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
  });
  manager.loadedThreads.add("one");
  manager.upsertThread(provider, {
    id: "one",
    cwd: "/tmp",
    sandbox: "read-only",
  });
  await manager.updateThreadSettings("provider", "one", {
    sandbox: "workspace-write",
    reasoningEffort: "high",
  });
  assert.equal(calls[0].method, "thread/settings/update");
  assert.equal(calls[0].params.sandbox, undefined);
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(calls[0].params.effort, "high");
  assert.equal(calls[0].params.reasoningEffort, undefined);
  assert.equal(manager.listThreads()[0].sandbox, "workspace-write");
});

test("turn/start re-applies the stored workspace-write policy", async () => {
  const provider = { id: "provider", kind: "local-profile", model: "m" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return {
          thread: { id: "fresh", cwd: "/tmp/project" },
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    },
  });
  await manager.createThread("provider", {
    cwd: "/tmp/project",
    sandbox: "workspace-write",
  });
  await manager.sendTurn("provider", "fresh", "写一个文件");
  const turn = calls.find((call) => call.method === "turn/start");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite" });
  assert.equal(manager.listThreads()[0].sandbox, "workspace-write");
});

test("provider switch forks full history with a new model provider", async () => {
  const providers: Record<string, any> = {
    source: { id: "source", name: "Source", model: "old", enabled: true },
    target: {
      id: "target",
      name: "Target",
      kind: "cc-switch",
      model: "new",
      baseUrl: "https://target.example/v1",
      wireApi: "responses",
      enabled: true,
    },
  };
  const manager = new CodexManager(
    { get: (id: string) => providers[id] } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async (providerId: string) => ({
    request: async (method: string, params: any) => {
      calls.push({ providerId, method, params });
      if (method === "thread/fork")
        return {
          thread: {
            id: "switched-thread",
            cwd: "/tmp/project",
            modelProvider: compileRuntimeProvider(providers.target)
              .modelProvider,
          },
        };
      return {};
    },
  });
  manager.upsertThread(providers.source, {
    id: "old-thread",
    cwd: "/tmp/project",
    name: "原任务",
    status: "idle",
  });

  const switched = await manager.migrateThread(
    "source",
    "old-thread",
    "target",
  );
  assert.equal(switched.id, "switched-thread");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["thread/fork"],
  );
  assert.equal(calls[0].providerId, "target");
  assert.equal(calls[0].params.threadId, "old-thread");
  assert.equal(calls[0].params.model, "new");
  assert.equal(
    manager.listThreads().find((thread: any) => thread.id === "switched-thread")
      .providerId,
    "target",
  );
});

test("unsent thread switches provider without forking a missing rollout", async () => {
  const providers: Record<string, any> = {
    source: { id: "source", name: "Source", model: "old", enabled: true },
    target: {
      id: "target",
      name: "Target",
      kind: "cc-switch",
      model: "new",
      baseUrl: "https://target.example/v1",
      wireApi: "responses",
      enabled: true,
    },
  };
  const manager = new CodexManager(
    { get: (id: string) => providers[id] } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  let starts = 0;
  manager.ensure = async (providerId: string) => ({
    request: async (method: string, params: any) => {
      calls.push({ providerId, method, params });
      if (method === "thread/start") {
        starts += 1;
        return {
          thread: {
            id: starts === 1 ? "fresh" : "switched",
            cwd: params.cwd || "/tmp/project",
          },
        };
      }
      if (method === "thread/fork")
        throw new Error("no rollout found for thread id fresh");
      return {};
    },
  });

  await manager.createThread("source", {
    cwd: "/tmp/project",
    sandbox: "read-only",
    approvalPolicy: "never",
    name: "空任务",
  });
  const switched = await manager.migrateThread("source", "fresh", "target", {
    model: "new",
  });

  assert.equal(switched.id, "switched");
  assert.equal(
    calls.filter((call) => call.method === "thread/fork").length,
    0,
  );
  const started = calls.find(
    (call) => call.method === "thread/start" && call.providerId === "target",
  );
  assert.equal(started.params.cwd, "/tmp/project");
  assert.equal(started.params.model, "new");
  assert.equal(started.params.sandbox, "read-only");
  assert.equal(started.params.approvalPolicy, "never");
  assert.equal(manager.threads.get("fresh"), undefined);
  assert.equal(manager.threads.get("switched").providerId, "target");
  assert.equal(manager.threads.get("switched").sandbox, "read-only");
  assert.equal(manager.threads.get("switched").approvalPolicy, "never");
  assert.equal(manager.threads.get("switched").migratedFrom.threadId, "fresh");
});

test("provider switch falls back to a new thread when fork finds no rollout", async () => {
  const providers: Record<string, any> = {
    source: { id: "source", name: "Source", model: "old", enabled: true },
    target: {
      id: "target",
      name: "Target",
      kind: "cc-switch",
      model: "new",
      baseUrl: "https://target.example/v1",
      wireApi: "responses",
      enabled: true,
    },
  };
  const manager = new CodexManager(
    { get: (id: string) => providers[id] } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      if (method === "thread/fork")
        throw new Error("no rollout found for thread id old-thread");
      if (method === "thread/start")
        return { thread: { id: "started", cwd: "/tmp/project" } };
      return {};
    },
  });
  manager.upsertThread(providers.source, {
    id: "old-thread",
    cwd: "/tmp/project",
    status: "idle",
  });

  const switched = await manager.migrateThread(
    "source",
    "old-thread",
    "target",
  );
  assert.equal(switched.id, "started");
  assert.deepEqual(calls, ["thread/fork", "thread/start"]);
  assert.equal(manager.threads.get("old-thread"), undefined);
});

test("provider switch still reports unrelated fork errors", async () => {
  const providers: Record<string, any> = {
    source: { id: "source", name: "Source", enabled: true },
    target: {
      id: "target",
      name: "Target",
      kind: "cc-switch",
      model: "new",
      baseUrl: "https://target.example/v1",
      enabled: true,
    },
  };
  const manager = new CodexManager(
    { get: (id: string) => providers[id] } as any,
    "/tmp",
  ) as any;
  manager.ensure = async () => ({
    request: async (method: string) => {
      if (method === "thread/fork") throw new Error("connection lost");
      throw new Error(`unexpected ${method}`);
    },
  });
  manager.upsertThread(providers.source, {
    id: "old-thread",
    cwd: "/tmp/project",
    status: "idle",
  });
  await assert.rejects(
    () => manager.migrateThread("source", "old-thread", "target"),
    /connection lost/,
  );
});

test("terminal command connects to the shared runtime without exposing secrets", () => {
  const provider = {
    id: "relay",
    name: "Relay",
    kind: "cc-switch",
    baseUrl: "https://relay.example/v1",
    apiKey: "super-secret",
    model: "gpt-test",
  };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
    "codex",
    4567,
  );
  const command = manager.terminalCommand("relay", "/tmp/my project");
  assert.match(command, /codex --remote ws:\/\/127\.0\.0\.1:4567/);
  assert.match(command, /-C ['"]\/tmp\/my project['"]/);
  assert.match(command, /model_provider/);
  assert.doesNotMatch(command, /super-secret/);
});

test("thread history restores and then clears the latest turn error", () => {
  const manager = new CodexManager({} as any, "/tmp") as any;
  const provider = { id: "provider", model: "m" };
  manager.upsertThread(provider, {
    id: "thread",
    cwd: "/tmp",
    turns: [
      {
        status: "failed",
        error: { message: "unauthorized", codexErrorInfo: "unauthorized" },
      },
    ],
  });
  assert.equal(manager.listThreads()[0].status, "error");
  assert.equal(manager.listThreads()[0].errorCode, "unauthorized");

  manager.upsertThread(provider, {
    id: "thread",
    cwd: "/tmp",
    turns: [{ status: "completed", error: null }],
  });
  assert.equal(manager.listThreads()[0].status, "idle");
  assert.equal(manager.listThreads()[0].lastError, undefined);
});

test("upsertThread keeps sandbox, fork, session and usage across thread/list refresh", async () => {
  const provider = { id: "local", model: "m", kind: "local-profile" };
  const manager = new CodexManager(
    {
      runtimeProviders: () => [provider],
      runtimeProfile: () => provider,
      listPublic: () => [],
      get: () => provider,
    } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(provider, {
    id: "kept",
    cwd: "/tmp/p",
    sandbox: "read-only",
    approvalPolicy: "never",
    forkedFromId: "src",
    sessionId: "sess-1",
    tokenUsage: { used: 12_000, limit: 272_000 },
  });
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      if (method !== "thread/list") throw new Error(method);
      return {
        data: params.archived
          ? []
          : [{ id: "kept", cwd: "/tmp/p", preview: "refreshed" }],
      };
    },
  });
  await manager.refreshAll();
  const thread = manager.listThreads()[0];
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.forkedFromId, "src");
  assert.equal(thread.sessionId, "sess-1");
  assert.deepEqual(thread.tokenUsage, { used: 12_000, limit: 272_000 });
});

test("list refresh without timestamps keeps the previous updatedAt", async () => {
  const provider = { id: "local", model: "m", kind: "local-profile" };
  const manager = new CodexManager(
    {
      runtimeProviders: () => [provider],
      runtimeProfile: () => provider,
      listPublic: () => [],
      get: () => provider,
    } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(provider, {
    id: "aged",
    cwd: "/tmp/p",
    updatedAt: "2024-01-02T03:04:05.000Z",
  });
  const before = manager.listThreads()[0].updatedAt;
  assert.equal(before, Date.parse("2024-01-02T03:04:05.000Z"));
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      if (method !== "thread/list") throw new Error(method);
      return {
        data: params.archived ? [] : [{ id: "aged", cwd: "/tmp/p", preview: "later" }],
      };
    },
  });
  await manager.refreshAll();
  assert.equal(manager.listThreads()[0].updatedAt, before);
});

test("upsertThread falls back to UUIDv7 time when list has no timestamp", () => {
  const provider = { id: "local", model: "m", kind: "local-profile" };
  const manager = new CodexManager(
    {
      runtimeProviders: () => [provider],
      runtimeProfile: () => provider,
      listPublic: () => [],
      get: () => provider,
    } as any,
    "/tmp",
  ) as any;
  const id = "019ffddc-408f-7e00-b7a1-5444c1acadf8";
  manager.upsertThread(provider, { id, cwd: "/tmp/p" });
  assert.equal(
    manager.listThreads()[0].updatedAt,
    Number.parseInt("019ffddc408f", 16),
  );
});

test("upsertThread reads updated_at unix seconds", () => {
  const provider = { id: "local", model: "m", kind: "local-profile" };
  const manager = new CodexManager(
    {
      runtimeProviders: () => [provider],
      runtimeProfile: () => provider,
      listPublic: () => [],
      get: () => provider,
    } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(provider, {
    id: "unix",
    cwd: "/tmp/p",
    updated_at: 1_704_164_645,
  });
  assert.equal(manager.listThreads()[0].updatedAt, 1_704_164_645_000);
});

test("failed archived list is recorded on runtime instead of swallowed", async () => {
  const provider = { id: "local", model: "m", kind: "local-profile" };
  const manager = new CodexManager(
    {
      runtimeProviders: () => [],
      runtimeProfile: () => provider,
      listPublic: () => [],
      get: () => provider,
    } as any,
    "/tmp",
  ) as any;
  manager.ensure = async () => ({
    request: async (_method: string, params: any) => {
      if (params.archived) throw new Error("archive list exploded");
      return { data: [] };
    },
  });
  await manager.refreshAll();
  assert.equal(manager.runtimeStatus().archiveError, "archive list exploded");
});

test("createThread omits personality when unset", async () => {
  const provider = {
    id: "provider",
    name: "OpenAI",
    kind: "local-profile",
    model: "m",
  };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "fresh", cwd: "/tmp" } };
      return {};
    },
  });
  await manager.createThread("provider", { cwd: "/tmp" });
  assert.equal("personality" in calls[0].params, false);
  assert.equal(calls[0].params.sandbox, "workspace-write");
  assert.equal(manager.listThreads()[0].sandbox, "workspace-write");
});

test("acceptForSession is forwarded as-is on command approval respond", async () => {
  const manager = new CodexManager(
    { get: () => ({ id: "p" }) } as any,
    "/tmp",
  ) as any;
  const responds: any[] = [];
  manager.ensure = async () => ({
    respond: (_id: unknown, result: unknown) => responds.push(result),
  });
  manager.approvals.set("a1", {
    providerId: "p",
    request: {
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t", command: "ls" },
    },
  });
  await manager.resolveApproval("a1", { decision: "acceptForSession" });
  assert.deepEqual(responds, [{ decision: "acceptForSession" }]);
});

test("permission and question approvals respond without throwing", async () => {
  const manager = new CodexManager(
    { get: () => ({ id: "p" }) } as any,
    "/tmp",
  ) as any;
  const responds: any[] = [];
  manager.ensure = async () => ({
    respond: (_id: unknown, result: unknown) => responds.push(result),
  });
  manager.approvals.set("perm", {
    providerId: "p",
    request: {
      id: 1,
      method: "item/permissions/requestApproval",
      params: { permissions: [{ name: "net" }] },
    },
  });
  manager.approvals.set("q", {
    providerId: "p",
    request: {
      id: 2,
      method: "item/requestUserInput",
      params: { questions: [{ prompt: "x" }] },
    },
  });
  await manager.resolveApproval("perm", {
    permissions: [{ name: "net", granted: true }],
    scope: "session",
  });
  await manager.resolveApproval("q", { answers: [{ text: "yes" }] });
  assert.deepEqual(responds, [
    { permissions: [{ name: "net", granted: true }], scope: "session" },
    { answers: [{ text: "yes" }] },
  ]);
});

test("unknown approval method does not respond", async () => {
  const manager = new CodexManager(
    { get: () => ({ id: "p" }) } as any,
    "/tmp",
  ) as any;
  let responded = false;
  manager.ensure = async () => ({
    respond: () => {
      responded = true;
    },
  });
  manager.approvals.set("u", {
    providerId: "p",
    request: { id: 3, method: "item/mystery/please", params: {} },
  });
  await assert.rejects(
    () => manager.resolveApproval("u", { decision: "accept" }),
    /未知审批类型/,
  );
  assert.equal(responded, false);
  assert.equal(manager.approvals.has("u"), true);
});

test("stale loaded thread is resumed after turn/start says thread not found", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      if (method === "turn/start" && calls.filter((item) => item === "turn/start").length === 1)
        throw new Error("thread not found: t");
      return method === "turn/start" ? { turn: { id: "turn-2" } } : {};
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp" });
  const result = await manager.sendTurn("provider", "t", "继续");
  assert.equal(result.turn.id, "turn-2");
  assert.deepEqual(calls, ["turn/start", "thread/resume", "turn/start"]);
});

test("sendTurn maps a failed resume after thread not found", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  manager.ensure = async () => ({
    request: async (method: string) => {
      if (method === "turn/start" || method === "thread/resume")
        throw new Error("thread not found: t");
      return {};
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp" });
  await assert.rejects(
    manager.sendTurn("provider", "t", "继续"),
    /当前 Runtime 里没有这条会话/,
  );
});

test("running thread with activeTurnId steers instead of starting", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push(method);
      return { method, params };
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp" });
  const thread = manager.threads.get("t");
  thread.status = "running";
  thread.activeTurnId = "turn-9";
  await manager.sendTurn("provider", "t", "追加");
  assert.deepEqual(calls, ["turn/steer"]);
});

test("steer no active turn falls back to turn/start", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      if (method === "turn/steer") throw new Error("no active turn");
      return {};
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp" });
  const thread = manager.threads.get("t");
  thread.status = "running";
  thread.activeTurnId = "turn-9";
  await manager.sendTurn("provider", "t", "追加");
  assert.deepEqual(calls, ["turn/steer", "turn/start"]);
});

test("idle sendTurn only starts a turn", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      return {};
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp", status: "idle" });
  await manager.sendTurn("provider", "t", "新指令");
  assert.deepEqual(calls, ["turn/start"]);
});

test("sendTurn can attach pasted image data URLs", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp", status: "idle" });
  const image = {
    url: "data:image/png;base64,aGVsbG8=",
    name: "shot.png",
  };
  await manager.sendTurn("provider", "t", "看看这张图", [image]);
  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.input, [
    { type: "text", text: "看看这张图", text_elements: [] },
    { type: "image", url: image.url },
  ]);
});

test("review, shell and goal use dedicated Codex methods", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return { ok: true };
    },
  });
  manager.loadedThreads.add("t");
  manager.upsertThread(provider, { id: "t", cwd: "/tmp" });
  await manager.reviewThread("provider", "t");
  await manager.runShellCommand("provider", "t", "git status --short");
  await manager.setThreadGoal("provider", "t", "把测试跑绿");
  await manager.setThreadGoal("provider", "t", "");
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "review/start",
      "thread/shellCommand",
      "thread/goal/set",
      "thread/goal/clear",
    ],
  );
  assert.equal(calls[0].params.target.type, "uncommittedChanges");
  assert.equal(calls[1].params.command, "git status --short");
  assert.equal(calls[2].params.objective, "把测试跑绿");
});

test("compact issues thread/compact/start", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: string[] = [];
  manager.ensure = async () => ({
    request: async (method: string) => {
      calls.push(method);
      return { ok: true };
    },
  });
  manager.upsertThread(provider, { id: "t", cwd: "/tmp" });
  await manager.compactThread("provider", "t");
  assert.deepEqual(calls, ["thread/compact/start"]);
  assert.equal(manager.listThreads()[0].compacting, true);
});

test("non-chatgpt official usage yields null rateLimits not 0%", async () => {
  const manager = new CodexManager({ listPublic: () => [] } as any, "/tmp") as any;
  manager.client = {
    online: true,
    request: async (method: string) => {
      if (method === "account/read")
        return { account: { auth_mode: "apikey" } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const runtime = await manager.loadOfficialUsage();
  assert.equal(runtime.rateLimits, null);
  assert.match(runtime.rateLimitsError || "", /Official|ChatGPT|额度/);
  assert.notEqual(runtime.rateLimitsError, "0%");
});

test("account/read type=chatgpt loads Official rate limits", async () => {
  const manager = new CodexManager({ listPublic: () => [] } as any, "/tmp") as any;
  const calls: string[] = [];
  manager.client = {
    online: true,
    request: async (method: string) => {
      calls.push(method);
      if (method === "account/read")
        return {
          account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        };
      if (method === "account/rateLimits/read")
        return {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_730_947_200 },
            secondary: { usedPercent: 8, resetsAt: 1_731_033_600 },
          },
        };
      throw new Error(`unexpected ${method}`);
    },
  };
  const runtime = await manager.loadOfficialUsage();
  assert.deepEqual(calls, ["account/read", "account/rateLimits/read"]);
  assert.equal(runtime.account?.chatgpt, true);
  assert.equal(runtime.account?.email, "user@example.com");
  assert.equal(runtime.rateLimits?.primary?.usedPercent, 25);
  assert.equal(runtime.rateLimitsError, undefined);
});

test("account/rateLimits/updated updates the snapshot", () => {
  const manager = new CodexManager({ listPublic: () => [] } as any, "/tmp") as any;
  manager.onNotification({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        primary: { used_percent: 42, resets_in_seconds: 3600 },
      },
    },
  });
  const runtime = manager.runtimeStatus();
  assert.equal(runtime.rateLimits?.primary?.usedPercent, 42);
  assert.equal(runtime.rateLimitsError, undefined);
});

test("fork forwards lastTurnId and records forkedFromId", async () => {
  const provider = { id: "provider", kind: "local-profile", model: "m" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/fork")
        return { thread: { id: "branch", cwd: "/tmp" } };
      return {};
    },
  });
  manager.loadedThreads.add("src");
  manager.upsertThread(provider, {
    id: "src",
    cwd: "/tmp",
    name: "源会话",
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const created = await manager.forkThread("provider", "src", {
    lastTurnId: "turn-3",
  });
  const fork = calls.find((call) => call.method === "thread/fork");
  assert.equal(fork.params.lastTurnId, "turn-3");
  assert.equal(created.forkedFromId, "src");
  assert.equal(manager.threads.get("branch").forkedFromId, "src");
  assert.equal(manager.threads.get("branch").name, "源会话 · 分支");
});

test("running source rejects turn-level fork", async () => {
  const provider = { id: "provider", kind: "local-profile" };
  const manager = new CodexManager(
    { get: () => provider } as any,
    "/tmp",
  ) as any;
  manager.upsertThread(provider, {
    id: "src",
    cwd: "/tmp",
    status: "running",
  });
  manager.threads.get("src").status = "running";
  await assert.rejects(
    () => manager.forkThread("provider", "src", { lastTurnId: "turn-1" }),
    /无法从中间回合分支/,
  );
});

test("migrate copies source sandbox and approval", async () => {
  const providers: Record<string, any> = {
    source: { id: "source", name: "Source", model: "old", enabled: true },
    target: {
      id: "target",
      name: "Target",
      kind: "cc-switch",
      model: "new",
      baseUrl: "https://target.example/v1",
      wireApi: "responses",
      enabled: true,
    },
  };
  const manager = new CodexManager(
    { get: (id: string) => providers[id] } as any,
    "/tmp",
  ) as any;
  const calls: any[] = [];
  manager.ensure = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/fork")
        return {
          thread: {
            id: "switched",
            cwd: "/tmp/project",
            modelProvider: compileRuntimeProvider(providers.target)
              .modelProvider,
          },
        };
      return {};
    },
  });
  manager.upsertThread(providers.source, {
    id: "old-thread",
    cwd: "/tmp/project",
    status: "idle",
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  await manager.migrateThread("source", "old-thread", "target");
  assert.equal(calls[0].params.sandbox, "read-only");
  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.equal(manager.threads.get("switched").sandbox, "read-only");
  assert.equal(manager.threads.get("switched").approvalPolicy, "never");
});

test("refreshAll remembers newly seen project directories", async () => {
  const seen: { cwd?: string; updatedAt?: number }[][] = [];
  const manager = new CodexManager(
    {
      runtimeProviders: () => [],
      runtimeProfile: () => ({ id: "local", kind: "local-profile" }),
      listPublic: () => [],
      get: () => ({ id: "local", kind: "local-profile" }),
      revision: 1,
    } as any,
    "/tmp",
    undefined,
    undefined,
    false,
    {
      connectionRevision: 0,
      overlayForProvider: () => ({}),
      rememberSeen: async () => false,
      rememberSeenMany: async (items: { cwd?: string; updatedAt?: number }[]) => {
        seen.push(items);
        return true;
      },
    } as any,
  ) as any;
  manager.ensure = async () => ({
    request: async (_method: string, params: any) => ({
      data: params.archived
        ? []
        : [{ id: "hist", cwd: "D:\\Code\\from-history", preview: "old" }],
    }),
  });
  await manager.refreshAll();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0]?.cwd, "D:\\Code\\from-history");
});

test("configPending follows connection overlay revision", () => {
  const manager = new CodexManager(
    { revision: 3 } as any,
    "/tmp",
    undefined,
    undefined,
    false,
    { connectionRevision: 2 } as any,
  ) as any;
  manager.client = { online: true };
  manager.loadedProviderRevision = 3;
  manager.loadedConnectionRevision = 1;
  assert.equal(manager.runtimeStatus().configPending, true);
  manager.loadedConnectionRevision = 2;
  assert.equal(manager.runtimeStatus().configPending, false);
});

test("runtimeStatus reports WSL mode from the constructor", () => {
  const native = new CodexManager({ listPublic: () => [] } as any, "/tmp");
  assert.equal(native.runtimeStatus().runtimeWsl, false);
  const wsl = new CodexManager(
    { listPublic: () => [] } as any,
    "/tmp",
    undefined,
    undefined,
    true,
  );
  assert.equal(wsl.runtimeStatus().runtimeWsl, true);
});

