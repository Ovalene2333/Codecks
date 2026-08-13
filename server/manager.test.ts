import test from "node:test";
import assert from "node:assert/strict";
import { CodexManager } from "./manager.js";

test("thread identities remain isolated when homes contain the same thread id", () => {
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
  assert.equal(manager.listThreads().length, 2);
  assert.deepEqual(
    new Set(manager.listThreads().map((thread: any) => thread.providerId)),
    new Set(["wsl", "windows"]),
  );
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
  const provider = { id: "provider", model: "m" };
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
  const manager = new CodexManager({} as any, "/tmp") as any;
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
    { get: () => ({ id: "provider" }) } as any,
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
