import assert from "node:assert/strict";
import test from "node:test";
import {
  FREQUENT_MODEL_GROUP,
  RECENT_MODEL_GROUP,
  STARRED_MODEL_GROUP,
  affinityListParams,
  composeModelOptions,
  type ModelAffinityData,
} from "./model-affinity";
import type { SearchableOption } from "./SearchablePicker";

const base: SearchableOption[] = [
  { value: "default", label: "跟随 OpenCode 默认", meta: "默认" },
  {
    value: "openai/gpt-5.2",
    label: "GPT-5.2",
    group: "OpenAI",
    groupMeta: "已连接",
    hint: "openai/gpt-5.2",
    connected: true,
  },
  {
    value: "openai/gpt-5.1",
    label: "GPT-5.1",
    group: "OpenAI",
    hint: "openai/gpt-5.1",
    connected: true,
  },
  {
    value: "anthropic/sonnet",
    label: "Sonnet",
    group: "Anthropic",
    hint: "anthropic/sonnet",
    connected: true,
  },
  {
    value: "local/dead",
    label: "Dead",
    group: "Local",
    hint: "local/dead",
  },
];

test("params mirror the model catalog key granularity", () => {
  assert.deepEqual(affinityListParams("opencode", "", "/work"), {
    directory: "/work",
  });
  assert.deepEqual(affinityListParams("opencode", "", ""), {});
  assert.deepEqual(affinityListParams("codex", "openai"), {
    providerId: "openai",
  });
  assert.deepEqual(affinityListParams("codex", ""), {});
});

test("no affinity returns the base list untouched", () => {
  assert.equal(composeModelOptions(base, null, ""), base);
});

test("starred models move to a top group without duplicates", () => {
  const composed = composeModelOptions(
    base,
    { starred: ["openai/gpt-5.1", "local/dead"], counts: {}, last: null, updatedAt: 0 },
    "",
  );
  const values = composed.map((option) => option.value);
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(values.slice(0, 2), ["openai/gpt-5.1", "local/dead"]);
  assert.deepEqual(
    composed.slice(0, 2).map((option) => [option.group, option.starred]),
    [
      [STARRED_MODEL_GROUP, true],
      [STARRED_MODEL_GROUP, true],
    ],
  );
  // 星标从原供应商分组里挪走，OpenAI 组只剩一条
  assert.deepEqual(
    composed.filter((option) => option.group === "OpenAI").map((o) => o.value),
    ["openai/gpt-5.2"],
  );
});

test("last selection gets its own group unless already elsewhere", () => {
  const composed = composeModelOptions(
    base,
    {
      starred: [],
      counts: { "openai/gpt-5.2": 2 },
      last: "anthropic/sonnet",
      updatedAt: 0,
    },
    "",
  );
  const rows = composed.filter((option) => option.value === "anthropic/sonnet");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, RECENT_MODEL_GROUP);
  // 次数最高但不是上次的选择进常用组
  const frequent = composed.filter(
    (option) => option.group === FREQUENT_MODEL_GROUP,
  );
  assert.deepEqual(
    frequent.map((option) => option.value),
    ["openai/gpt-5.2"],
  );
});

test("current selection is never moved into affinity groups", () => {
  const composed = composeModelOptions(
    base,
    {
      starred: ["openai/gpt-5.2"],
      counts: { "openai/gpt-5.2": 9, "openai/gpt-5.1": 4 },
      last: "openai/gpt-5.2",
      updatedAt: 0,
    },
    "openai/gpt-5.2",
  );
  assert.deepEqual(
    composed
      .filter((option) => option.value === "openai/gpt-5.2")
      .map((o) => [o.group, o.starred]),
    [["OpenAI", true]],
  );
  assert.ok(!composed.some((option) => option.group === RECENT_MODEL_GROUP));
});

test("frequent picks take top three by count, skipping stale ids", () => {
  const affinity: ModelAffinityData = {
    starred: [],
    counts: {
      "openai/gpt-5.1": 5,
      "openai/gpt-5.2": 3,
      "anthropic/sonnet": 8,
      default: 2,
      "ghost/model": 99,
    },
    last: null,
    updatedAt: 0,
  };
  const composed = composeModelOptions(base, affinity, "");
  assert.deepEqual(
    composed
      .filter((option) => option.group === FREQUENT_MODEL_GROUP)
      .map((option) => option.value),
    ["anthropic/sonnet", "openai/gpt-5.1", "openai/gpt-5.2"],
  );
});
