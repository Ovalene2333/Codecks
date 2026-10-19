import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSummary } from "../types";
import { threadUsage } from "../format";
import { buildUsageStats, usageTotal } from "./stats";

function thread(
  id: string,
  cwd: string,
  used: number,
  extra: Partial<ThreadSummary["tokenUsage"]> = {},
): ThreadSummary {
  return {
    id,
    providerId: "local",
    name: `Session ${id}`,
    preview: "",
    cwd,
    model: "gpt-5",
    status: "idle",
    updatedAt: Number(id.replace(/\D/g, "")) || 1,
    tokenUsage: { used, ...extra },
  };
}

test("usageTotal falls back to input plus cached input plus output", () => {
  assert.equal(usageTotal({ input: 12, output: 3, cachedInput: 7 }), 22);
  assert.equal(
    usageTotal({ input: 623, cachedInput: 393_200, output: 340, reasoningOutput: 0 }),
    394_163,
  );
  assert.equal(usageTotal({ used: 20, input: 12, output: 3 }), 20);
  assert.equal(usageTotal({ total: 30, used: 8, input: 12, output: 3 }), 30);
});

test("buildUsageStats aggregates sessions by normalized project path", () => {
  const stats = buildUsageStats([
    thread("1", "D:\\Code\\Deck", 100, { input: 80, output: 20 }),
    thread("2", "/mnt/d/code/deck", 50, {
      input: 40,
      cachedInput: 10,
      output: 10,
    }),
    thread("3", "/work/other", 25),
  ]);

  assert.equal(stats.totals.total, 175);
  assert.equal(stats.projects.length, 2);
  assert.equal(stats.projects[0]?.name.toLowerCase(), "deck");
  assert.equal(stats.projects[0]?.sessionCount, 2);
  assert.equal(stats.projects[0]?.totals.total, 150);
  assert.equal(stats.projects[0]?.totals.cachedInput, 10);
  assert.deepEqual(
    stats.sessions.map((row) => row.totals.total),
    [100, 50, 25],
  );
});

test("buildUsageStats prefers the native session total over the latest step", () => {
  const session = thread("1", "/work/opencode", 394_163, {
    input: 623,
    cachedInput: 393_200,
    output: 340,
  });
  session.tokenUsageTotal = {
    input: 921_385,
    cachedInput: 12_462_431,
    output: 58_280,
    used: 921_385 + 58_280 + 12_462_431,
  };
  const stats = buildUsageStats([session]);
  assert.equal(stats.sessions[0]?.totals.output, 58_280);
  assert.equal(stats.totals.total, 13_442_096);
  assert.equal(threadUsage(session)?.cachedInput, 12_462_431);
});

test("buildUsageStats keeps a freshly copied fork from doubling the bill", () => {
  const parent = thread("1", "/work/opencode", 13_399_935, {
    input: 3_619_981,
    cachedInput: 70_069_496,
    output: 130_764,
  });
  parent.agentId = "opencode";
  const copy = { ...parent, id: "2", forkedFromId: "1", updatedAt: 2 };
  const stats = buildUsageStats([parent, copy]);
  // 复制后没继续跑：新增为 0，总量等于父会话，不会凭空翻倍。
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.totals.total, 13_399_935);
  assert.equal(stats.sessions[0]?.duplicated.total, 0);
});

test("buildUsageStats still collapses branches whose parent left the snapshot", () => {
  const parent = thread("1", "/work/opencode", 13_442_096, {
    input: 3_619_981,
    cachedInput: 70_069_496,
    output: 133_011,
  });
  parent.agentId = "opencode";
  const freshFork = {
    ...parent,
    id: "2",
    updatedAt: 2,
    tokenUsage: { used: 13_399_935, input: 3_619_981, cachedInput: 70_069_496, output: 130_764 },
    forkedFromId: "1",
  };
  const grownFork = {
    ...parent,
    id: "3",
    updatedAt: 3,
    tokenUsage: { used: 20_000_000, input: 5_000_000, cachedInput: 100_000_000, output: 200_000 },
    forkedFromId: "2",
  };
  // 父会话已不在快照里：只能保留最新一条并扣掉最小那份（纯复制历史）。
  const stats = buildUsageStats([freshFork, grownFork]);
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.sessions[0]?.thread.id, "3");
  assert.equal(stats.totals.total, 20_000_000);
  assert.equal(stats.sessions[0]?.duplicated.total, 13_399_935);
});

test("buildUsageStats adds each branch's own consumption when baselines exist", () => {
  const base = {
    input: 3_000_000,
    cachedInput: 60_000_000,
    output: 100_000,
    total: 63_100_000,
    used: 60_000,
  };
  const parent = { ...thread("1", "/work/opencode", 0), agentId: "opencode" };
  parent.tokenUsage = { ...base };
  // 两个分支各自从同一基线出发继续跑。
  const branchA = {
    ...parent,
    id: "2",
    forkedFromId: "1",
    updatedAt: 2,
    tokenUsage: { ...base, output: 110_000, total: 63_110_000 },
    forkUsageBaseline: { ...base },
  };
  const branchB = {
    ...parent,
    id: "3",
    forkedFromId: "1",
    updatedAt: 3,
    tokenUsage: { ...base, output: 150_000, total: 63_150_000 },
    forkUsageBaseline: { ...base },
  };
  const stats = buildUsageStats([parent, branchA, branchB]);

  // 父会话 63.1M + A 新增 10K + B 新增 50K，三条都在活动，互不覆盖。
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.sessions[0]?.totals.total, 63_160_000);
  assert.equal(stats.sessions[0]?.totals.output, 160_000);
  assert.equal(stats.sessions[0]?.thread.id, "3");
});

test("buildUsageStats deduplicates the same session across libraries", () => {
  const older = thread("1", "/work/deck", 100);
  const newer = { ...older, updatedAt: 2, tokenUsage: { used: 140 } };
  const stats = buildUsageStats([older, newer]);
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.totals.total, 140);
});
