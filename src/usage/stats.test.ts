import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSummary } from "../types";
import { buildUsageStats, threadUsage, usageTotal } from "./stats";

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

test("buildUsageStats deduplicates the same session across libraries", () => {
  const older = thread("1", "/work/deck", 100);
  const newer = { ...older, updatedAt: 2, tokenUsage: { used: 140 } };
  const stats = buildUsageStats([older, newer]);
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.totals.total, 140);
});
