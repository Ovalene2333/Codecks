import test from "node:test";
import assert from "node:assert/strict";
import {
  activeStreamItemId,
  appendCodexEvent,
  collectStreamedAgentMessages,
} from "./streaming.ts";

const delta = (
  text: unknown,
  itemId: string,
  overrides: Record<string, unknown> = {},
) => ({
  providerId: "official",
  method: "item/agentMessage/delta",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    delta: text,
  },
  ...overrides,
});

test("streaming keeps separate agent items separate and ordered", () => {
  assert.deepEqual(
    collectStreamedAgentMessages(
      [
        delta("先", "commentary"),
        delta("处理", "commentary"),
        delta("完成", "final"),
      ],
      "official",
      "thread-1",
      "turn-1",
    ),
    [
      { itemId: "commentary", text: "先处理" },
      { itemId: "final", text: "完成" },
    ],
  );
});

test("streaming isolates provider, thread, and active turn", () => {
  const events = [
    delta("正确", "a"),
    delta("错误供应商", "b", { providerId: "custom" }),
    delta("错误会话", "c", {
      params: {
        threadId: "thread-2",
        turnId: "turn-1",
        itemId: "c",
        delta: "错误会话",
      },
    }),
    delta("错误回合", "d", {
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "d",
        delta: "错误回合",
      },
    }),
  ];

  assert.deepEqual(
    collectStreamedAgentMessages(events, "official", "thread-1", "turn-1"),
    [{ itemId: "a", text: "正确" }],
  );
});

test("streaming normalizes structured delta text", () => {
  assert.deepEqual(
    collectStreamedAgentMessages(
      [delta({ text: "结构化" }, "a")],
      "official",
      "thread-1",
      "turn-1",
    ),
    [{ itemId: "a", text: "结构化" }],
  );
});

test("delta events accumulate without dropping the start of long replies", () => {
  let events: any[] = [];
  for (let index = 0; index < 500; index += 1) {
    events = appendCodexEvent(events, delta(String(index % 10), "long"));
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].params.delta.length, 500);
  assert.equal(events[0].params.delta.startsWith("0123456789"), true);
});

test("a new turn drops the previous stream for the same provider and thread", () => {
  const previous = delta("旧回复", "old");
  const started = {
    providerId: "official",
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2" } },
  };
  assert.deepEqual(appendCodexEvent([previous], started), [started]);
});

test("ordinary event limits do not evict an active accumulated stream", () => {
  let events: any[] = [delta("完整回复", "active")];
  for (let index = 0; index < 300; index += 1) {
    events = appendCodexEvent(events, {
      method: "item/completed",
      params: { threadId: `other-${index}` },
    });
  }
  assert.equal(
    events.some((event) => event?.params?.itemId === "active"),
    true,
  );
});

test("the most recently updated agent item owns the streaming cursor", () => {
  let events: any[] = [];
  events = appendCodexEvent(events, delta("A", "first"));
  events = appendCodexEvent(events, delta("B", "second"));
  events = appendCodexEvent(events, delta("C", "first"));
  const messages = collectStreamedAgentMessages(
    events,
    "official",
    "thread-1",
    "turn-1",
  );

  assert.equal(activeStreamItemId(messages), "first");
  assert.deepEqual(messages, [
    { itemId: "second", text: "B" },
    { itemId: "first", text: "AC" },
  ]);
});
