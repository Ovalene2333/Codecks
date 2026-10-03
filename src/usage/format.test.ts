import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_QUOTA_TITLE,
  formatResetCountdown,
  formatResetLabel,
  formatWindowLength,
  rankedQuotaWindows,
  remainingPercent,
  RESET_IMMINENT,
  USAGE_UNAVAILABLE,
  usageChipMetric,
  usageTone,
} from "./format.ts";

test("usage chip never paints a fake 0% when limits are missing", () => {
  assert.equal(CODEX_QUOTA_TITLE, "Codex 额度");
  assert.equal(usageChipMetric(null, "read failed"), USAGE_UNAVAILABLE);
  assert.equal(usageChipMetric(undefined), USAGE_UNAVAILABLE);
  assert.equal(USAGE_UNAVAILABLE, "额度不可用");
  assert.notEqual(usageChipMetric(null), "0%");
});

test("usage chip formats remaining percent and reset countdown", () => {
  assert.equal(
    usageChipMetric({
      primary: { usedPercent: 31.2, resetAfterSeconds: 5 * 3600 },
    }),
    "69% · 5h",
  );
  assert.equal(usageTone({ primary: { usedPercent: 90 } }), "warn");
  assert.equal(
    usageTone({ primary: { usedPercent: 40, reached: true } }),
    "danger",
  );
});

test("remaining percent is clamped to the visible quota range", () => {
  assert.equal(remainingPercent(31.2), 69);
  assert.equal(remainingPercent(110), 0);
  assert.equal(remainingPercent(-5), 100);
  assert.equal(remainingPercent(undefined), undefined);
});

test("window length uses days and hours instead of raw minutes", () => {
  assert.equal(formatWindowLength(10080), "7d");
  assert.equal(formatWindowLength(300), "5h");
  assert.equal(formatWindowLength(15), "15m");
});

test("usage chip falls back to secondary when primary is missing", () => {
  assert.equal(
    usageChipMetric({
      secondary: { usedPercent: 12, resetAfterSeconds: 3600 },
    }),
    "88% · 1h",
  );
});

test("expired windows say 即将重置 instead of 0s", () => {
  const past = Date.now() - 60_000;
  assert.equal(formatResetCountdown({ resetsAt: past }), RESET_IMMINENT);
  assert.equal(formatResetLabel({ resetsAt: past }), RESET_IMMINENT);
  assert.equal(formatResetCountdown({ resetAfterSeconds: 0 }), RESET_IMMINENT);
  assert.equal(
    usageChipMetric({ primary: { usedPercent: 44, resetsAt: past } }),
    "56% · 即将重置",
  );
});

test("resetsAt wins over the stale relative resetAfterSeconds", () => {
  assert.equal(
    formatResetLabel({
      resetsAt: Date.now() + 2 * 3_600_000,
      resetAfterSeconds: 30,
    }),
    "2h 后重置",
  );
});

test("ranked quota windows put the easier-to-hit window first", () => {
  const rows = rankedQuotaWindows({
    primary: { usedPercent: 40, windowDurationMins: 300 },
    secondary: { usedPercent: 88, windowDurationMins: 10_080 },
    monthly: { usedPercent: 95 },
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.label, row.remaining]),
    [
      ["monthly", "月度", 5],
      ["secondary", "7d", 12],
      ["primary", "5h", 60],
    ],
  );
  // chip 跟首页一样按「更容易触顶」选窗口，不是永远主窗口。
  assert.equal(
    usageChipMetric({
      primary: { usedPercent: 40, resetAfterSeconds: 3_600 },
      secondary: { usedPercent: 88, resetAfterSeconds: 86_400 },
    }),
    "12% · 1d",
  );
  assert.equal(
    usageTone({
      primary: { usedPercent: 10 },
      secondary: { usedPercent: 90 },
    }),
    "warn",
  );
});

test("windows without usage data never get ranked", () => {
  const rows = rankedQuotaWindows({
    primary: { windowDurationMins: 300 },
    byLimitId: { bonus: { usedPercent: 5 } },
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["limit:bonus"],
  );
  assert.equal(rankedQuotaWindows(null).length, 0);
});
