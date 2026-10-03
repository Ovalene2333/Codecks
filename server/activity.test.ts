import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_HEARTBEAT_MS,
  ActivityTracker,
  compactActivityItem,
} from "./activity.js";

const event = (method: string, params: any, agentId = "claude") => ({
  type: "agent.event",
  data: { agentId, providerId: "p", method, params },
});

test("turn start and tool items drive the current step", () => {
  const tracker = new ActivityTracker();
  const started = tracker.ingest(
    event("turn/started", { threadId: "t1", turn: { id: "turn-1" } }),
    1_000,
  );
  assert.equal(started?.activity?.turnStartedAt, 1_000);
  assert.equal(started?.activity?.step, undefined);

  const tool = tracker.ingest(
    event("item/started", {
      threadId: "t1",
      item: {
        id: "cmd-1",
        type: "commandExecution",
        status: "inProgress",
        command: "npm test",
        aggregatedOutput: "x".repeat(10_000),
      },
    }),
    2_000,
  );
  assert.equal(tool?.activity?.step?.item.command, "npm test");
  assert.equal(tool?.activity?.step?.startedAt, 2_000);
  assert.equal("aggregatedOutput" in (tool?.activity?.step?.item || {}), false);

  const done = tracker.ingest(
    event("item/completed", {
      threadId: "t1",
      item: { id: "cmd-1", type: "commandExecution", status: "completed" },
    }),
    3_000,
  );
  assert.equal(done?.activity?.step, undefined);

  const finished = tracker.ingest(
    event("turn/completed", {
      threadId: "t1",
      turn: { id: "turn-1", status: "failed" },
    }),
    9_000,
  );
  assert.equal(finished?.activity?.turnStartedAt, undefined);
  assert.deepEqual(finished?.activity?.lastTurn, {
    startedAt: 1_000,
    endedAt: 9_000,
    status: "failed",
  });
});

test("deltas only heartbeat after the throttle window", () => {
  const tracker = new ActivityTracker();
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "a" } }), 0);
  const message = tracker.ingest(
    event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "hi" }),
    100,
  );
  assert.equal(message?.activity?.step?.item.type, "agentMessage");
  assert.equal(
    tracker.ingest(
      event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "!" }),
      200,
    ),
    undefined,
  );
  const heartbeat = tracker.ingest(
    event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "." }),
    100 + ACTIVITY_HEARTBEAT_MS,
  );
  assert.equal(heartbeat?.activity?.lastEventAt, 100 + ACTIVITY_HEARTBEAT_MS);
});

test("a new tool closes open message and reasoning steps", () => {
  const tracker = new ActivityTracker();
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "a" } }), 0);
  tracker.ingest(
    event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "x" }),
    10,
  );
  tracker.ingest(
    event("item/started", {
      threadId: "t1",
      item: { id: "f1", type: "fileChange", changes: [{ path: "a.ts", diff: "..." }] },
    }),
    20,
  );
  const done = tracker.ingest(
    event("item/completed", { threadId: "t1", item: { id: "f1", type: "fileChange" } }),
    30,
  );
  // 消息已被新工具收尾：文件改完后回到“等模型”，而不是退回旧的“输出回复”。
  assert.equal(done?.activity?.step, undefined);
});

test("OpenCode native part snapshots are normalized", () => {
  const tracker = new ActivityTracker();
  const update = tracker.ingest(
    event(
      "item/updated",
      {
        threadId: "t1",
        item: {
          id: "part-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", input: { command: "ls -la" } },
        },
      },
      "opencode",
    ),
    5,
  );
  assert.equal(update?.activity?.step?.item.command, "ls -la");
  const completed = tracker.ingest(
    event(
      "item/updated",
      {
        threadId: "t1",
        item: {
          id: "part-1",
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "ls -la" } },
        },
      },
      "opencode",
    ),
    6,
  );
  assert.equal(completed?.activity?.step, undefined);
});

test("thread status fills in turns the tracker never saw start or end", () => {
  const tracker = new ActivityTracker();
  const running = tracker.ingest(
    {
      type: "thread.updated",
      data: { id: "t1", agentId: "codex", status: "running", updatedAt: 500 },
    },
    1_000,
  );
  assert.equal(running?.activity?.turnStartedAt, 500);
  const errored = tracker.ingest(
    { type: "thread.updated", data: { id: "t1", agentId: "codex", status: "error" } },
    2_000,
  );
  assert.equal(errored?.activity?.lastTurn?.status, "failed");
  assert.equal(
    tracker.ingest(
      { type: "thread.updated", data: { id: "t1", agentId: "codex", status: "idle" } },
      2_100,
    ),
    undefined,
  );
  const deleted = tracker.ingest(
    { type: "thread.deleted", data: { threadId: "t1" } },
    3_000,
  );
  assert.deepEqual(deleted, { agentId: "codex", threadId: "t1", activity: null });
  assert.equal(tracker.list().length, 0);
});

test("late turn/completed after an idle status update corrects the result", () => {
  const tracker = new ActivityTracker();
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "a" } }), 0);
  tracker.ingest(
    { type: "thread.updated", data: { id: "t1", agentId: "claude", status: "error" } },
    1_000,
  );
  const late = tracker.ingest(
    event("turn/completed", { threadId: "t1", turn: { id: "a", status: "interrupted" } }),
    1_010,
  );
  assert.equal(late?.activity?.lastTurn?.status, "interrupted");
  assert.equal(late?.activity?.lastTurn?.startedAt, 0);
});

test("compactActivityItem keeps only whitelisted short input fields", () => {
  const item = compactActivityItem({
    id: "x",
    type: "commandExecution",
    tool: "Edit",
    input: {
      file_path: "/repo/src/a.ts",
      old_string: "a".repeat(5_000),
      new_string: "b".repeat(5_000),
    },
  });
  assert.deepEqual(item?.input, { file_path: "/repo/src/a.ts" });
  assert.equal(compactActivityItem({ id: "u", type: "userMessage" }), undefined);
});

test("the last reply of a turn is kept as a short preview", () => {
  const tracker = new ActivityTracker();
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "a" } }), 0);
  // Claude/ACP：只有 delta 带文本，completed 不带。
  tracker.ingest(event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "先看一下" }), 10);
  tracker.ingest(event("item/agentMessage/delta", { threadId: "t1", itemId: "m2", delta: "  已修复重试逻辑，" }), 20);
  tracker.ingest(event("item/agentMessage/delta", { threadId: "t1", itemId: "m2", delta: "测试全部通过。" }), 30);
  tracker.ingest(event("item/completed", { threadId: "t1", item: { id: "m2", type: "agentMessage" } }), 40);
  const done = tracker.ingest(
    event("turn/completed", { threadId: "t1", turn: { id: "a", status: "completed" } }),
    50,
  );
  assert.equal(done?.activity?.lastTurn?.reply, "已修复重试逻辑，测试全部通过。");

  // 下一轮没有回复：不能沿用上一轮的预览。
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "b" } }), 100);
  const quiet = tracker.ingest(
    event("turn/completed", { threadId: "t1", turn: { id: "b", status: "interrupted" } }),
    200,
  );
  assert.deepEqual(quiet?.activity?.lastTurn, { startedAt: 100, endedAt: 200, status: "interrupted" });
});

test("full-text reply items replace deltas and long replies are clipped", () => {
  const tracker = new ActivityTracker();
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "a" } }, "codex"), 0);
  tracker.ingest(event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "草稿" }, "codex"), 10);
  tracker.ingest(
    event("item/completed", { threadId: "t1", item: { id: "m1", type: "agentMessage", text: "x".repeat(1_000) } }, "codex"),
    20,
  );
  const done = tracker.ingest(
    event("turn/completed", { threadId: "t1", turn: { id: "a", status: "completed" } }, "codex"),
    30,
  );
  assert.equal(done?.activity?.lastTurn?.reply, `${"x".repeat(240)}…`);
});

test("a turn closed by thread status still carries its reply", () => {
  const tracker = new ActivityTracker();
  tracker.ingest(event("turn/started", { threadId: "t1", turn: { id: "a" } }), 0);
  tracker.ingest(event("item/agentMessage/delta", { threadId: "t1", itemId: "m1", delta: "构建失败" }), 10);
  const closed = tracker.ingest(
    { type: "thread.updated", data: { id: "t1", agentId: "claude", status: "error", updatedAt: 20 } },
    20,
  );
  assert.equal(closed?.activity?.lastTurn?.status, "failed");
  assert.equal(closed?.activity?.lastTurn?.reply, "构建失败");
});
