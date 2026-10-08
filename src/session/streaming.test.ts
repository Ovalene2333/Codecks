import test from "node:test";
import assert from "node:assert/strict";
import {
  activeStreamItemId,
  appendCodexEvent,
  collectStreamed,
  collectStreamedAgentMessages,
  collectStreamedTurnItems,
  liveUserMessagesCoveredByHistory,
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

test("user message start/completion events are collected for immediate rendering and reconciliation", () => {
  const item = { id: "user-live", type: "userMessage", content: [{ type: "text", text: "问题" }] };
  const events = ["item/started", "item/completed"].map((method) => ({
    method, providerId: "official", params: { threadId: "thread-1", turnId: "turn-1", item },
  }));
  const live = collectStreamed(events, "official", "thread-1", "turn-1");
  assert.equal(live.items.length, 1);
  assert.equal(live.items[0].item.type, "userMessage");
  assert.equal(live.items[0].item.status, "completed");
  assert.deepEqual(live.entries, [{ kind: "item", itemId: "user-live" }]);
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

test("a live user message with a different runtime id is covered by matching history", () => {
  const history = [
    {
      id: "user-persisted",
      type: "userMessage",
      content: [{ type: "text", text: "姓名 Ovalene 邮箱 894381852@qq.com" }],
    },
    { id: "msg-1", type: "agentMessage", text: "收到" },
  ];
  const live = [
    {
      itemId: "user-live",
      item: {
        id: "user-live",
        type: "userMessage",
        content: [
          { type: "text", text: "姓名 Ovalene 邮箱 894381852@qq.com" },
        ],
        status: "completed",
      },
    },
    {
      itemId: "read-1",
      item: {
        id: "read-1",
        type: "commandExecution",
        command: "cat SKILL.md",
        status: "inProgress",
      },
    },
  ];
  assert.deepEqual(
    [...liveUserMessagesCoveredByHistory(history, live)],
    ["user-live"],
  );
  assert.deepEqual(
    mergeTurnItems(history, live).map((item) => item.id),
    ["user-persisted", "msg-1", "read-1"],
  );
});

test("unmatched live user messages still append and claims stay one-to-one", () => {
  const userItem = (id: string, text: string) => ({
    itemId: id,
    item: { id, type: "userMessage", content: [{ type: "text", text }] },
  });
  // 历史里没有同文消息 → live 消息照常追加。
  const noMatch = mergeTurnItems(
    [{ id: "user-1", type: "userMessage", text: "别的话" }],
    [userItem("user-live", "新消息")],
  );
  assert.deepEqual(
    noMatch.map((item) => item.id),
    ["user-1", "user-live"],
  );
  // 同一文本连发两次：历史只有一份时第二个 live 副本不被吞掉。
  const history = [{ id: "user-1", type: "userMessage", text: "继续" }];
  const doubled = mergeTurnItems(history, [
    userItem("live-a", "继续"),
    userItem("live-b", "继续"),
  ]);
  assert.deepEqual(
    doubled.map((item) => item.id),
    ["user-1", "live-b"],
  );
  // 图片数不一致不算同一条。
  const withImage = mergeTurnItems(history, [
    {
      itemId: "live-img",
      item: {
        id: "live-img",
        type: "userMessage",
        content: [
          { type: "text", text: "继续" },
          { type: "image", url: "data:image/png;base64,YQ==" },
        ],
      },
    },
  ]);
  assert.deepEqual(
    withImage.map((item) => item.id),
    ["user-1", "live-img"],
  );
});

test("native item/updated snapshots convert and replace their previous state", () => {
  let events: any[] = [];
  const update = (todos: any[]) => ({
    agentId: "opencode",
    providerId: "openai",
    method: "item/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "prt-todo",
        type: "tool",
        tool: "todowrite",
        state: {
          status: todos.length ? "completed" : "running",
          title: "Update todos",
          metadata: { todos },
        },
      },
    },
  });

  events = appendCodexEvent(events, update([]));
  events = appendCodexEvent(events, update([{ content: "ship it" }]));
  events = appendCodexEvent(events, delta("回答", "msg-1"));
  assert.equal(events.length, 2, "repeated part updates coalesce");

  const items = collectStreamedTurnItems(events, "openai", "thread-1", "turn-1", "opencode");
  assert.equal(items.length, 1);
  assert.equal(items[0].item.type, "commandExecution");
  assert.equal(items[0].item.tool, "todowrite");
  assert.deepEqual(items[0].item.todos, [{ content: "ship it" }]);
});

test("OpenCode text deltas use the part id used by persisted history", () => {
  const events = [
    {
      agentId: "opencode",
      providerId: "openai",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "part-1",
        delta: "same message",
      },
    },
  ];
  assert.deepEqual(
    collectStreamedAgentMessages(
      events,
      "openai",
      "thread-1",
      "turn-1",
      "opencode",
    ),
    [{ itemId: "part-1", text: "same message" }],
  );
  assert.ok(
    streamsCoveredByHistory(
      [{ id: "part-1", type: "agentMessage", text: "same message" }],
      [{ itemId: "part-1", text: "same message", completed: true }],
    ).has("part-1"),
  );
});

test("OpenCode text deltas continue from the last native part snapshot", () => {
  const base = {
    agentId: "opencode",
    providerId: "openai",
    params: { threadId: "thread-1", turnId: "turn-1" },
  };
  const events = [
    {
      ...base,
      method: "item/updated",
      params: { ...base.params, item: { id: "part-1", type: "text", text: "Hello" } },
    },
    {
      ...base,
      method: "item/agentMessage/delta",
      params: { ...base.params, itemId: "part-1", delta: " world" },
    },
  ];
  assert.deepEqual(
    collectStreamedAgentMessages(events, "openai", "thread-1", "turn-1", "opencode"),
    [{ itemId: "part-1", text: "Hello world" }],
  );
});

test("live entries interleave messages and items in event order", () => {
  let events: any[] = [];
  const tool = (id: string, status = "completed") => ({
    providerId: "official",
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id, type: "commandExecution", command: id, status },
    },
  });
  events = appendCodexEvent(events, delta("先", "msg-1"));
  events = appendCodexEvent(events, tool("tool-1"));
  events = appendCodexEvent(events, delta("后", "msg-2"));
  events = appendCodexEvent(events, tool("tool-2"));

  const live = collectStreamed(events, "official", "thread-1", "turn-1");
  assert.deepEqual(live.entries, [
    { kind: "message", itemId: "msg-1" },
    { kind: "item", itemId: "tool-1" },
    { kind: "message", itemId: "msg-2" },
    { kind: "item", itemId: "tool-2" },
  ]);
});

test("a message still streaming sits at its latest position in entries", () => {
  let events: any[] = [];
  const tool = (id: string) => ({
    providerId: "official",
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id, type: "commandExecution", command: id },
    },
  });
  events = appendCodexEvent(events, delta("A", "msg-1"));
  events = appendCodexEvent(events, tool("tool-1"));
  // 同一消息继续流入时合并事件移到尾部，位置跟随最近一次活动。
  events = appendCodexEvent(events, delta("B", "msg-1"));

  const live = collectStreamed(events, "official", "thread-1", "turn-1");
  assert.deepEqual(live.entries, [
    { kind: "item", itemId: "tool-1" },
    { kind: "message", itemId: "msg-1" },
  ]);
});

test("extension items stream live for Claude todo snapshots", () => {
  const events = [
    {
      agentId: "claude",
      providerId: "claude-current",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "todo-tool-1",
          type: "extension",
          kind: "todo",
          agentId: "claude",
          status: "completed",
          payload: { todos: [{ content: "build", status: "in_progress" }] },
        },
      },
    },
  ];

  const items = collectStreamedTurnItems(events, "claude-current", "thread-1", "turn-1", "claude");
  assert.equal(items.length, 1);
  assert.equal(items[0].item.kind, "todo");
  assert.equal(
    mergeTurnItems([], items)[0].payload.todos[0].content,
    "build",
  );
});
