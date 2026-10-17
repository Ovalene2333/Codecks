import assert from "node:assert/strict";
import test from "node:test";
import { AccountQuotaTracker } from "./account-quota.js";
import type { RateLimits } from "./types.js";

const now = Date.now();
const ids = new Set(["demo"]);
const limits = (percent: number, end = now + 3600_000): RateLimits => ({
  primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: end },
  secondary: {
    usedPercent: percent,
    windowDurationMins: 10080,
    resetsAt: now + 6 * 86400_000,
  },
});
const usage = (n: number) => ({
  total: n * 1000,
  input: n * 600,
  cachedInput: n * 300,
  output: n * 100,
});

test("account billing pairs live model cost and percentage deltas within the same cycle", () => {
  const tracker = new AccountQuotaTracker();
  tracker.observe("demo@example.com", limits(40), ids, now);
  tracker.record("demo", usage(1000), usage(1001), "gpt-5.4");
  tracker.record("other", usage(1000), usage(2000), "gpt-5.4");
  tracker.observe("demo@example.com", limits(45), ids, now + 1000);
  const sample = tracker.samples(now)[0];
  assert.equal(sample.stageTokens, 1000);
  assert.equal(sample.usedPercent, 5);
  assert.ok(
    Math.abs(sample.stageCost - (600 * 2.5 + 300 * 0.25 + 100 * 15) / 1e6) <
      1e-10,
  );
});

test("reset clears the 5h baseline without losing the current 7d cycle", () => {
  const tracker = new AccountQuotaTracker();
  tracker.observe("demo@example.com", limits(40), ids, now);
  tracker.record("demo", usage(1), usage(2), "gpt-5.4");
  tracker.observe("demo@example.com", limits(50), ids, now + 1000);
  const reset = limits(55, now + 5 * 3600_000);
  reset.primary!.usedPercent = 0;
  tracker.observe("demo@example.com", reset, ids, now + 2000);
  assert.deepEqual(
    tracker.samples(now).map((s) => s.windowDurationMins),
    [10080],
  );
  tracker.record("demo", usage(2), usage(3), "gpt-5.4");
  reset.primary!.usedPercent = 10;
  tracker.observe("demo@example.com", reset, ids, now + 3000);
  assert.equal(tracker.samples(now)[0].stageTokens, 1000);
  assert.equal(tracker.samples(now)[1].stageTokens, 2000);
});

test("percentage drops reset the baseline even when reset time is unchanged", () => {
  const tracker = new AccountQuotaTracker();
  tracker.observe("demo@example.com", limits(40), ids, now);
  tracker.record("demo", usage(1), usage(2), "gpt-5.4");
  tracker.observe("demo@example.com", limits(50), ids, now);
  tracker.observe("demo@example.com", limits(5), ids, now);
  assert.deepEqual(tracker.samples(now), []);
  tracker.record("demo", usage(2), usage(3), "gpt-5.4");
  tracker.observe("demo@example.com", limits(10), ids, now);
  assert.equal(tracker.samples(now)[0].stageTokens, 1000);
  assert.equal(tracker.samples(now)[0].usedPercent, 5);
});

test("unknown history, zero progress, expired windows and account changes do not produce estimates", () => {
  const tracker = new AccountQuotaTracker();
  tracker.observe("demo@example.com", limits(40), ids, now);
  tracker.record("demo", undefined, usage(100000), "gpt-5.4");
  tracker.observe("demo@example.com", limits(50), ids, now);
  assert.deepEqual(tracker.samples(now), []);
  tracker.record("demo", usage(1), usage(2), "gpt-5.4");
  tracker.observe("demo@example.com", limits(50), ids, now);
  assert.equal(tracker.samples(now).length, 2);
  assert.deepEqual(tracker.samples(now + 7 * 86400_000), []);
  tracker.observe("other@example.com", limits(60), ids, now);
  assert.deepEqual(tracker.samples(now), []);
  tracker.observe("other@example.com", limits(60), new Set(["other"]), now);
  assert.deepEqual(tracker.samples(now), []);
});
