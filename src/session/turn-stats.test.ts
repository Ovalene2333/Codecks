import assert from "node:assert/strict";
import test from "node:test";
import {
  applyExpandedTurns,
  describeStep,
  formatFoldedSize,
  formatTps,
  formatToolDuration,
  formatTurnDuration,
  progressTps,
  statsLine,
} from "./turn-stats";

test("formatTps keeps one decimal below 100", () => {
  assert.equal(formatTps(47.619), "47.6 token/s");
  assert.equal(formatTps(166.666), "167 token/s");
  assert.equal(formatTps(0), "");
  assert.equal(formatTps(undefined), "");
});

test("progressTps divides output by elapsed seconds", () => {
  assert.equal(
    progressTps({ outputTokens: 100, elapsedMs: 2_100 }),
    "47.6 token/s",
  );
  assert.equal(progressTps({ outputTokens: 0, elapsedMs: 2_100 }), "");
  assert.equal(progressTps({ outputTokens: 100, elapsedMs: 0 }), "");
});

test("formatTurnDuration uses decimal seconds under a minute", () => {
  assert.equal(formatTurnDuration(32_400), "32.4 s");
  assert.equal(formatTurnDuration(0), "0.0 s");
  assert.equal(formatTurnDuration(252_000), "4 分 12 秒");
  assert.equal(formatTurnDuration(undefined), "");
});

test("formatToolDuration shows even short runs, hides instant ones", () => {
  assert.equal(formatToolDuration(1_200, 2_000), "用时 0.8 s");
  assert.equal(formatToolDuration(0, 90), "");
  assert.equal(formatToolDuration(1_000, 2_500), "用时 1.5 s");
  assert.equal(formatToolDuration(1_000, 33_000), "用时 32.0 s");
  assert.equal(formatToolDuration(undefined, 2_000), "");
  assert.equal(formatToolDuration(2_000, 1_000), "");
});

test("statsLine composes duration and tps, skipping what is missing", () => {
  assert.equal(
    statsLine({ durationMs: 32_000, outputTokens: 100, tps: 47.6 }),
    "用时 32.0 s 47.6 token/s",
  );
  assert.equal(statsLine({ durationMs: 32_000 }), "用时 32.0 s");
  assert.equal(statsLine({ outputTokens: 100 }), "生成 100 tokens");
  assert.equal(statsLine(undefined), "");
});

test("formatFoldedSize scales chars to readable units", () => {
  assert.equal(formatFoldedSize(38_000), "37 KB");
  assert.equal(formatFoldedSize(500), "500 字");
  assert.equal(formatFoldedSize(0), "");
});

test("applyExpandedTurns overlays unfolded turns by id", () => {
  const full = {
    turns: [
      { id: "t1", items: [{ id: "a", folded: true }] },
      { id: "t2", items: [] },
    ],
  };
  const expanded = new Map([
    ["t1", { id: "t1", items: [{ id: "a", aggregatedOutput: "full" }] }],
  ]);
  const next: any = applyExpandedTurns(full, expanded);
  assert.equal(next.turns[0].items[0].aggregatedOutput, "full");
  assert.equal(next.turns[1], full.turns[1]);
  // 原对象不动。
  assert.equal(full.turns[0].items[0].folded, true);
  assert.equal(applyExpandedTurns(full, new Map()), full);
});

test("describeStep speaks the same language as tool rows", () => {
  assert.equal(describeStep(undefined), "");
  assert.equal(describeStep({ item: { type: "reasoning" } }), "思考过程");
  assert.equal(describeStep({ item: { type: "agentMessage" } }), "正在回复");
  assert.equal(
    describeStep({
      item: { type: "commandExecution", tool: "bash", input: { command: "ls -la" } },
    }),
    "正在执行 ls -la",
  );
  assert.ok(
    describeStep({
      item: {
        type: "commandExecution",
        commandActions: [{ type: "read", path: "/w/a.ts" }],
      },
    }).startsWith("正在读取"),
  );
  assert.equal(
    describeStep({ item: { type: "mcpToolCall", tool: "fetch" } }),
    "正在调用 fetch",
  );
});
