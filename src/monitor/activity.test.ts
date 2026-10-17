import test from "node:test";
import assert from "node:assert/strict";
import type { AgentDescriptor, ThreadActivity, ThreadSummary } from "../types.ts";
import {
  COMMAND_STALL_MS,
  STALL_MS,
  contextPercent,
  describeStep,
  formatDuration,
  formatElapsed,
  stalledFor,
  turnStartedAt,
} from "./activity.ts";
import { agentHealth, healthIssueCount } from "./health.ts";

function thread(status: ThreadSummary["status"], extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "t1",
    providerId: "p",
    name: "会话",
    preview: "",
    cwd: "/repo",
    model: "m",
    status,
    updatedAt: 1_000,
    ...extra,
  };
}

const activity = (extra: Partial<ThreadActivity> = {}): ThreadActivity => ({
  agentId: "codex",
  threadId: "t1",
  lastEventAt: 0,
  ...extra,
});

test("describeStep speaks the same verbs as the timeline", () => {
  assert.deepEqual(
    describeStep({ id: "1", type: "commandExecution", command: "/bin/bash -lc 'npm test'" }),
    { kind: "command", label: "执行", target: "npm test" },
  );
  assert.deepEqual(
    describeStep(
      { id: "2", type: "commandExecution", tool: "Read", input: { file_path: "/repo/src/a.ts" } },
      "/repo",
    ),
    { kind: "read", label: "读取", target: "src/a.ts" },
  );
  assert.deepEqual(
    describeStep(
      {
        id: "3",
        type: "fileChange",
        changes: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }],
        changeCount: 4,
      },
      "/repo",
    ),
    { kind: "edit", label: "编辑", target: "a.ts 等 4 个文件" },
  );
  assert.deepEqual(
    describeStep({
      id: "4",
      type: "commandExecution",
      tool: "WebFetch",
      command: 'WebFetch {"url":"https://x.dev"}',
      input: { url: "https://x.dev" },
    }),
    { kind: "web", label: "抓取网页", target: "https://x.dev" },
  );
  assert.deepEqual(
    describeStep({ id: "5", type: "mcpToolCall", server: "github", tool: "search_issues" }),
    { kind: "tool", label: "github.search_issues", target: "" },
  );
  assert.equal(describeStep({ id: "6", type: "reasoning" }).label, "思考中");
});

test("stalledFor only flags running sessions past the threshold", () => {
  assert.equal(stalledFor(thread("running"), activity(), STALL_MS - 1), undefined);
  assert.equal(stalledFor(thread("running"), activity(), STALL_MS), STALL_MS);
  assert.equal(stalledFor(thread("waiting"), activity(), STALL_MS * 10), undefined);
  const command = activity({
    step: { item: { id: "c", type: "commandExecution" }, startedAt: 0 },
  });
  assert.equal(stalledFor(thread("running"), command, STALL_MS), undefined);
  assert.equal(stalledFor(thread("running"), command, COMMAND_STALL_MS), COMMAND_STALL_MS);
});

test("turnStartedAt falls back to updatedAt for untracked running turns", () => {
  assert.equal(turnStartedAt(thread("running")), 1_000);
  assert.equal(turnStartedAt(thread("running"), activity({ turnStartedAt: 500 })), 500);
  assert.equal(turnStartedAt(thread("idle"), activity({ turnStartedAt: 500 })), undefined);
});

test("duration formatting", () => {
  assert.equal(formatElapsed(42_000), "00:42");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
  assert.equal(formatDuration(32_000), "32 秒");
  assert.equal(formatDuration(252_000), "4 分 12 秒");
  assert.equal(formatDuration(3_780_000), "1 小时 3 分");
  assert.equal(formatDuration(26 * 3_600_000), "1 天 2 小时");
  assert.equal(contextPercent({ used: 72, limit: 100 }), 72);
  assert.equal(contextPercent({ used: 72 }), undefined);
});

test("agent health separates outages from informational errors", () => {
  const base: AgentDescriptor = {
    id: "claude",
    name: "Claude",
    available: true,
    online: true,
    capabilities: {} as AgentDescriptor["capabilities"],
  };
  assert.equal(agentHealth(base).tone, "ok");
  assert.equal(agentHealth({ ...base, error: "turn failed" }).tone, "ok");
  assert.equal(agentHealth({ ...base, online: false, error: "spawn ENOENT" }).tone, "error");
  assert.equal(agentHealth({ ...base, available: false, online: false }).tone, "off");
  assert.equal(
    healthIssueCount(
      [base, { ...base, id: "x", online: false }],
      [
        {
          id: "p",
          name: "P",
          kind: "custom",
          color: "#000",
          hasApiKey: true,
          enabled: true,
          online: false,
          error: "401",
        },
      ],
    ),
    2,
  );
});
