import test from "node:test";
import assert from "node:assert/strict";
import {
  activeStreamItemId,
  appendCodexEvent,
  collectStreamedAgentMessages,
  collectStreamedTurnItems,
  mergeTurnItems,
  streamsCoveredByHistory,
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

test("long command output keeps its start event in the bounded event buffer", () => {
  let events: any[] = [
    {
      providerId: "official",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "install",
          type: "commandExecution",
          command: "npm install",
        },
      },
    },
  ];
  for (let index = 0; index < 500; index += 1) {
    events = appendCodexEvent(events, {
      providerId: "official",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "install",
        delta: String(index % 10),
      },
    });
  }

  assert.equal(events.length, 2);
  assert.equal(events[1].params.delta.length, 500);
  assert.equal(
    collectStreamedTurnItems(events, "official", "thread-1", "turn-1")[0]
      .item.aggregatedOutput.length,
    500,
  );
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

test("a new Claude turn does not drop a matching Codex stream", () => {
  const previous = delta("Codex 回复", "old");
  const started = {
    agentId: "claude",
    providerId: "official",
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2" } },
  };
  assert.deepEqual(appendCodexEvent([previous], started), [previous, started]);
});

test("a completed agent item marks its accumulated stream as completed", () => {
  const events = appendCodexEvent([delta("完整回复", "msg-runtime")], {
    providerId: "official",
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "msg-runtime", type: "agentMessage" },
    },
  });

  assert.deepEqual(
    collectStreamedAgentMessages(events, "official", "thread-1", "turn-1"),
    [{ itemId: "msg-runtime", text: "完整回复", completed: true }],
  );
});

test("completed streams reconcile with normalized history ids one-to-one", () => {
  const history = [{ id: "item-20", type: "agentMessage", text: "相同回复" }];
  assert.deepEqual(
    [
      ...streamsCoveredByHistory(history, [
        { itemId: "msg-runtime", text: "相同回复", completed: true },
        { itemId: "msg-other", text: "相同回复", completed: true },
        { itemId: "msg-live", text: "相同回复" },
      ]),
    ],
    ["msg-runtime"],
  );
});

test("an active Claude stream follows its persisted text position", () => {
  const liveText = "Let me search the project styles for the provider row.";
  const history = [
    { id: "history-message", type: "agentMessage", text: `${liveText} Done.` },
    { id: "tool-1", type: "commandExecution", command: "rg provider-row" },
  ];
  assert.deepEqual(
    [
      ...streamsCoveredByHistory(history, [
        { itemId: "live-api-id", text: liveText },
      ]),
    ],
    ["live-api-id"],
  );
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

test("live command items appear immediately and complete in place", () => {
  const events = [
    {
      providerId: "official",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm install -D @playwright/test",
        },
      },
    },
    {
      providerId: "official",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        delta: "added 3 packages",
      },
    },
    {
      providerId: "official",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm install -D @playwright/test",
          status: "completed",
        },
      },
    },
  ];

  assert.deepEqual(
    collectStreamedTurnItems(events, "official", "thread-1", "turn-1"),
    [
      {
        itemId: "command-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm install -D @playwright/test",
          aggregatedOutput: "added 3 packages",
          status: "completed",
        },
      },
    ],
  );
});

test("live turn items update matching history and append missing commands", () => {
  const history = [
    { id: "user-1", type: "userMessage", text: "安装 Playwright" },
    {
      id: "command-1",
      type: "commandExecution",
      command: "npm install",
      status: "inProgress",
    },
  ];
  assert.deepEqual(
    mergeTurnItems(history, [
      {
        itemId: "command-1",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm install",
          status: "completed",
        },
      },
      {
        itemId: "command-2",
        item: {
          id: "command-2",
          type: "commandExecution",
          command: "npx playwright install chromium",
          status: "inProgress",
        },
      },
    ]),
    [
      { id: "user-1", type: "userMessage", text: "安装 Playwright" },
      {
        id: "command-1",
        type: "commandExecution",
        command: "npm install",
        status: "completed",
      },
      {
        id: "command-2",
        type: "commandExecution",
        command: "npx playwright install chromium",
        status: "inProgress",
      },
    ],
  );
});
