import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSummary } from "../types";
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

test("usageTotal falls back to input plus output", () => {
  assert.equal(usageTotal({ input: 12, output: 3, cachedInput: 7 }), 15);
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

test("buildUsageStats deduplicates the same session across libraries", () => {
  const older = thread("1", "/work/deck", 100);
  const newer = { ...older, updatedAt: 2, tokenUsage: { used: 140 } };
  const stats = buildUsageStats([older, newer]);
  assert.equal(stats.sessions.length, 1);
  assert.equal(stats.totals.total, 140);
});
