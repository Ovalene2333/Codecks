import assert from "node:assert/strict";
import test from "node:test";
import type { Approval, ThreadActivity, ThreadSummary } from "../types";
import { activityKey } from "./activity-store";
import { STALL_MS } from "./activity";
import { buildHomeBoard, recentActivityAt, replyPreview, turnTone } from "./home";

const NOW = 10_000_000;
const thread = (id: string, extra: Partial<ThreadSummary> = {}) =>
  ({ id, name: id, cwd: "/w", status: "idle", updatedAt: NOW - 1_000, agentId: "codex", providerId: "p", preview: "", ...extra }) as ThreadSummary;
const map = (list: ThreadActivity[]) =>
  new Map(list.map((item) => [activityKey(item.agentId, item.threadId), item]));
const base = {
  activities: new Map<string, ThreadActivity>(),
  pendingOf: () => undefined,
  unseenSessions: new Set<string>(),
  now: NOW,
  recentLimit: 5,
};
const keys = (list: { thread: ThreadSummary }[]) => list.map((item) => item.thread.id);

test("status buckets are exclusive while recent includes all statuses", () => {
  const board = buildHomeBoard({
    ...base,
    threads: [
      thread("asking", { status: "waiting" }),
      thread("broken", { status: "error" }),
      thread("busy", { status: "running" }),
      thread("done"),
      thread("old"),
      thread("approval", { status: "waiting" }),
    ],
    unseenSessions: new Set(["codex:p:done"]),
    pendingOf: (item) => (item.id === "approval" ? [{ id: "x" } as Approval] : undefined),
  });
  // 审批会话仍可从最近会话找到。
  assert.deepEqual(keys(board.attention), ["asking", "broken"]);
  assert.deepEqual(keys(board.running), ["busy"]);
  assert.deepEqual(keys(board.unseen), ["done"]);
  assert.deepEqual(keys(board.recent), ["approval", "asking", "broken", "busy", "done"]);
});

test("a running session is not an unread reply even if flagged unseen", () => {
  const board = buildHomeBoard({
    ...base,
    threads: [thread("again", { status: "running" })],
    unseenSessions: new Set(["codex:p:again"]),
  });
  assert.deepEqual(keys(board.running), ["again"]);
  assert.deepEqual(board.unseen, []);
});

test("unread replies sort by when the turn ended, newest first", () => {
  const board = buildHomeBoard({
    ...base,
    threads: [thread("a", { updatedAt: NOW - 50 }), thread("b", { updatedAt: NOW - 10 })],
    unseenSessions: new Set(["codex:p:a", "codex:p:b"]),
    activities: map([
      { agentId: "codex", threadId: "a", lastEventAt: 0, lastTurn: { startedAt: 0, endedAt: NOW - 5, status: "completed" } },
    ]),
  });
  assert.deepEqual(keys(board.unseen), ["a", "b"]);
});

test("stalled runs float up; others keep a stable longest-first order", () => {
  const board = buildHomeBoard({
    ...base,
    threads: [
      thread("young", { status: "running" }),
      thread("old", { status: "running" }),
      thread("stuck", { status: "running" }),
    ],
    activities: map([
      { agentId: "codex", threadId: "young", turnStartedAt: NOW - 1_000, lastEventAt: NOW },
      { agentId: "codex", threadId: "old", turnStartedAt: NOW - 9_000, lastEventAt: NOW },
      { agentId: "codex", threadId: "stuck", turnStartedAt: NOW - 2_000, lastEventAt: NOW - STALL_MS - 1 },
    ]),
  });
  assert.deepEqual(keys(board.running), ["stuck", "old", "young"]);
  assert.ok(board.running[0].stalled! > STALL_MS);
});

test("recent is capped and newest first; waiting sorts before errors", () => {
  const board = buildHomeBoard({
    ...base,
    recentLimit: 2,
    threads: [
      thread("r1", { updatedAt: 1 }),
      thread("r2", { updatedAt: 3 }),
      thread("r3", { updatedAt: 2 }),
      thread("err", { status: "error", updatedAt: NOW }),
      thread("wait", { status: "waiting", updatedAt: 5 }),
    ],
  });
  assert.deepEqual(keys(board.recent), ["err", "wait"]);
  assert.deepEqual(keys(board.attention), ["wait", "err"]);
});

test("replyPreview flattens markdown into one readable line", () => {
  assert.equal(
    replyPreview("## 完成\n\n- 修复 **重试** 逻辑\n- 见 [文档](http://x)\n```ts\nconst a = 1;\n```\n`npm test` 通过"),
    "完成 修复 重试 逻辑 见 文档 npm test 通过",
  );
  assert.equal(replyPreview(undefined), "");
});

test("turnTone maps statuses to result tones", () => {
  assert.equal(turnTone("completed"), "ok");
  assert.equal(turnTone("failed"), "fail");
  assert.equal(turnTone("interrupted"), "stop");
});

test("recent includes running and ordinary sessions", () => {
  const board = buildHomeBoard({
    ...base,
    threads: [thread("watched"), thread("plain"), thread("busy", { status: "running" })],
  });
  assert.deepEqual(keys(board.recent), ["busy", "plain", "watched"]);
  // 运行中分组照常显示
  assert.deepEqual(keys(board.running), ["busy"]);
});


test("recent sorts live activity before limiting, with matching display time", () => {
  const board = buildHomeBoard({
    ...base, recentLimit: 2,
    threads: [thread("metadata", { updatedAt: NOW - 100 }), thread("live", { updatedAt: 1 }), thread("finished", { updatedAt: 2 })],
    activities: map([
      { agentId: "codex", threadId: "live", lastEventAt: NOW },
      { agentId: "codex", threadId: "finished", lastEventAt: 2, lastTurn: { startedAt: 2, endedAt: NOW - 1, status: "completed" } },
    ]),
  });
  assert.deepEqual(keys(board.recent), ["live", "finished"]);
  assert.equal(recentActivityAt(board.recent[0]), NOW);
  assert.equal(recentActivityAt({ thread: thread("fallback"), key: "fallback" }), NOW - 1000);
});
