import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWindowLength,
  OFFICIAL_USAGE_TITLE,
  USAGE_UNAVAILABLE,
  usageChipMetric,
  usageTone,
} from "./format.ts";

test("usage chip never paints a fake 0% when limits are missing", () => {
  assert.equal(OFFICIAL_USAGE_TITLE, "Official 账号额度");
  assert.equal(usageChipMetric(null, "read failed"), USAGE_UNAVAILABLE);
  assert.equal(usageChipMetric(undefined), USAGE_UNAVAILABLE);
  assert.equal(USAGE_UNAVAILABLE, "额度不可用");
  assert.notEqual(usageChipMetric(null), "0%");
});

test("usage chip formats primary percent and reset countdown", () => {
  assert.equal(
    usageChipMetric({
      primary: { usedPercent: 31.2, resetAfterSeconds: 5 * 3600 },
    }),
    "31% · 5h",
  );
  assert.equal(
    usageTone({ primary: { usedPercent: 90 } }),
    "warn",
  );
  assert.equal(
    usageTone({ primary: { usedPercent: 40, reached: true } }),
    "danger",
  );
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
    "12% · 1h",
  );
});
