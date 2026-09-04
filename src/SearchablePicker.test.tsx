import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterSearchableOptions,
  groupSearchableOptions,
  SearchablePicker,
  type SearchableOption,
} from "./SearchablePicker";

const options: SearchableOption[] = [
  { value: "default", label: "跟随 OpenCode 默认", meta: "默认" },
  {
    value: "anthropic/claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    group: "Anthropic",
    hint: "anthropic/claude-sonnet-4-5",
  },
  {
    value: "openai/gpt-5.2",
    label: "GPT-5.2",
    group: "OpenAI",
    hint: "openai/gpt-5.2",
  },
];

test("filter keeps everything for a blank query", () => {
  assert.equal(filterSearchableOptions(options, "").length, 3);
  assert.equal(filterSearchableOptions(options, "   ").length, 3);
});

test("filter matches label, value, group and hint case-insensitively", () => {
  assert.deepEqual(
    filterSearchableOptions(options, "sonnet").map((item) => item.value),
    ["anthropic/claude-sonnet-4-5"],
  );
  assert.deepEqual(
    filterSearchableOptions(options, "OPENAI").map((item) => item.value),
    ["openai/gpt-5.2"],
  );
  assert.deepEqual(
    filterSearchableOptions(options, "跟随").map((item) => item.value),
    ["default"],
  );
  assert.equal(filterSearchableOptions(options, "不存在").length, 0);
});

test("group consecutive options sharing a group name", () => {
  const grouped = groupSearchableOptions([
    { value: "a", label: "A" },
    { value: "b", label: "B", group: "X" },
    { value: "c", label: "C", group: "X" },
    { value: "d", label: "D", group: "Y" },
  ]);
  assert.equal(grouped.plain.length, 1);
  assert.deepEqual(
    grouped.groups.map((group) => [group.name, group.items.length]),
    [
      ["X", 2],
      ["Y", 1],
    ],
  );
});

test("grouping carries the group meta so provider state can be labelled", () => {
  const grouped = groupSearchableOptions([
    { value: "a", label: "A", group: "OpenAI" },
    {
      value: "b",
      label: "B",
      group: "Anthropic",
      groupMeta: "已连接",
    },
    { value: "c", label: "C", group: "Anthropic" },
  ]);
  assert.deepEqual(
    grouped.groups.map((group) => [group.name, group.meta]),
    [
      ["OpenAI", undefined],
      ["Anthropic", "已连接"],
    ],
  );
  assert.deepEqual(
    filterSearchableOptions(
      [
        {
          value: "b",
          label: "Sonnet",
          group: "Anthropic",
          groupMeta: "已连接",
        },
      ],
      "已连接",
    ).map((option) => option.value),
    ["b"],
  );
});

test("picker trigger renders the selected label and closes by default", () => {
  const html = renderToStaticMarkup(
    <SearchablePicker
      ariaLabel="模型"
      value="openai/gpt-5.2"
      options={options}
      onChange={() => undefined}
      placeholder="选择模型"
    />,
  );
  assert.match(html, /search-picker-trigger/);
  assert.match(html, /GPT-5\.2/);
  assert.match(html, /aria-expanded="false"/);
  assert.ok(!html.includes("search-picker-panel"));
});

test("picker trigger falls back to placeholder when value is unknown", () => {
  const html = renderToStaticMarkup(
    <SearchablePicker
      ariaLabel="模型"
      value=""
      options={options}
      onChange={() => undefined}
      placeholder="选择模型"
    />,
  );
  assert.match(html, /is-placeholder/);
  assert.match(html, /选择模型/);
});
