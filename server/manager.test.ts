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
                cwd: "\\\\?\\D:\\Code\\BSHT",
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
    cwd: "D:\\Code\\BSHT",
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
