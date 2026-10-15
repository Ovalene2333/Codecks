import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadSettingsStore } from "../thread-settings.js";
import { CodexAdapter } from "./codex-adapter.js";

test("Codex records per-turn timing, output delta and live progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const dir = await mkdtemp(path.join(tmpdir(), "deck-codex-turn-stats-"));
  const settings = new ThreadSettingsStore(dir);
  await settings.load();
  const adapter = new CodexAdapter(
    { listPublic: () => [] } as any,
    dir,
    undefined,
    undefined,
    false,
    undefined,
    [],
    false,
    settings,
  ) as any;
  (adapter.threads as Map<string, any>).set("t1", {
    agentId: "codex",
    id: "t1",
    providerId: "p",
    name: "t",
    preview: "",
    cwd: "",
    model: "m",
    status: "idle",
    updatedAt: 0,
    tokenUsage: { output: 1000, reasoningOutput: 100 },
  });
  const events: any[] = [];
  adapter.on("event", (event: any) => events.push(event));

  t.mock.timers.tick(2_000);
  adapter.onNotification({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn-1" } },
  });
  adapter.onNotification({
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      item: { id: "tool-1", type: "commandExecution", command: "ls" },
    },
  });
  adapter.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t1",
      tokenUsage: { output: 1200, reasoningOutput: 150 },
    },
  });
  adapter.onNotification({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      item: {
        id: "tool-1",
        type: "commandExecution",
        command: "ls",
        status: "completed",
      },
    },
  });
  t.mock.timers.tick(1_500);
  adapter.onNotification({
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
  });

  // 用量事件触发一次 turn/progress（首样本直推）：累计增量 250。
  const progress = events.filter(
    (event) => event?.data?.method === "turn/progress",
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].data.params.outputTokens, 250);
  assert.equal(progress[0].data.params.turnId, "turn-1");

  // turn/completed 按起止累计差结算并持久化：用时 1.5 秒，166.7 tok/s。
  assert.deepEqual(settings.turnStats("codex", "t1", "turn-1"), {
    turnId: "turn-1",
    startedAt: 2_000,
    endedAt: 3_500,
    durationMs: 1_500,
    outputTokens: 250,
    tps: 166.7,
  });

  // 工具行 Deck 侧计时：started 落开始，completed 落结束。
  const started = events.find(
    (event) => event?.data?.method === "item/started",
  );
  const completed = events.find(
    (event) => event?.data?.method === "item/completed",
  );
  assert.equal(started.data.params.item.startedAt, 2_000);
  assert.equal(completed.data.params.item.endedAt, 2_000);
});

test("Codex seeds a zero baseline for a brand-new thread instead of skipping TPS", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const dir = await mkdtemp(path.join(tmpdir(), "deck-codex-turn-stats-"));
  const settings = new ThreadSettingsStore(dir);
  await settings.load();
  const adapter = new CodexAdapter(
    { listPublic: () => [] } as any,
    dir,
    undefined,
    undefined,
    false,
    undefined,
    [],
    false,
    settings,
  ) as any;
  // 全新线程：没有 tokenUsage，usageStore 为空。
  (adapter.threads as Map<string, any>).set("new", {
    agentId: "codex",
    id: "new",
    providerId: "p",
    name: "n",
    preview: "",
    cwd: "",
    model: "m",
    status: "idle",
    updatedAt: 0,
  });
  const events: any[] = [];
  adapter.on("event", (event: any) => events.push(event));

  t.mock.timers.tick(2_000);
  adapter.onNotification({
    method: "turn/started",
    params: { threadId: "new", turn: { id: "turn-1" } },
  });
  t.mock.timers.tick(1_000);
  adapter.onNotification({
    method: "thread/tokenUsage/updated",
    params: { threadId: "new", tokenUsage: { output: 300, reasoningOutput: 60 } },
  });
  t.mock.timers.tick(1_000);
  adapter.onNotification({
    method: "turn/completed",
    params: { threadId: "new", turn: { id: "turn-1", status: "completed" } },
  });

  // 基线 0：首回合的累计生成就是本轮产出。
  const progress = events.filter(
    (event) => event?.data?.method === "turn/progress",
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].data.params.outputTokens, 360);
  assert.equal(progress[0].data.params.elapsedMs, 1_000);
  assert.equal(settings.turnStats("codex", "new", "turn-1").tps, 180);
});

test("Codex stamps per-item usage on reasoning and reply items", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const dir = await mkdtemp(path.join(tmpdir(), "deck-codex-turn-stats-"));
  const settings = new ThreadSettingsStore(dir);
  await settings.load();
  const adapter = new CodexAdapter(
    { listPublic: () => [] } as any,
    dir,
    undefined,
    undefined,
    false,
    undefined,
    [],
    false,
    settings,
  ) as any;
  (adapter.threads as Map<string, any>).set("t1", {
    agentId: "codex",
    id: "t1",
    providerId: "p",
    name: "t",
    preview: "",
    cwd: "",
    model: "m",
    status: "idle",
    updatedAt: 0,
    tokenUsage: { output: 1_000, reasoningOutput: 100 },
  });
  const events: any[] = [];
  adapter.on("event", (event: any) => events.push(event));

  t.mock.timers.tick(2_000);
  adapter.onNotification({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn-1" } },
  });
  adapter.onNotification({
    method: "item/started",
    params: { threadId: "t1", turnId: "turn-1", item: { id: "r1", type: "reasoning" } },
  });
  t.mock.timers.tick(500);
  adapter.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t1",
      tokenUsage: { output: 1_100, reasoningOutput: 300 },
    },
  });
  adapter.onNotification({
    method: "item/completed",
    params: { threadId: "t1", turnId: "turn-1", item: { id: "r1", type: "reasoning" } },
  });
  adapter.onNotification({
    method: "item/started",
    params: { threadId: "t1", turnId: "turn-1", item: { id: "m1", type: "agentMessage" } },
  });
  t.mock.timers.tick(400);
  adapter.onNotification({
    method: "thread/tokenUsage/updated",
    params: { threadId: "t1", tokenUsage: { output: 1_400, reasoningOutput: 300 } },
  });
  adapter.onNotification({
    method: "item/completed",
    params: { threadId: "t1", turnId: "turn-1", item: { id: "m1", type: "agentMessage" } },
  });

  const completed = events.filter(
    (event) => event?.data?.method === "item/completed",
  );
  // 思考 item：窗口 500ms 内吃进 200 reasoning token。
  assert.deepEqual(completed[0]?.data?.params?.item?.stats, {
    durationMs: 500,
    outputTokens: 200,
    tps: 400,
  });
  // 回复 item：窗口 400ms 内吃进 300 output token。
  assert.deepEqual(completed[1]?.data?.params?.item?.stats, {
    durationMs: 400,
    outputTokens: 300,
    tps: 750,
  });
});
