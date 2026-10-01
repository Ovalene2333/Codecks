import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnBlock } from "./TurnBlock.tsx";
import type { ThreadSummary } from "../types.ts";

test("an active turn renders exactly one streaming cursor", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: { id: "turn-1", status: "inProgress", items: [] },
      index: 1,
      thread,
      streamed: [
        { itemId: "message-1", text: "第一段" },
        { itemId: "message-2", text: "第二段" },
        { itemId: "message-3", text: "第三段" },
      ],
    }),
  );

  assert.equal((html.match(/message agent streaming/g) || []).length, 1);
  assert.equal((html.match(/<i><\/i>/g) || []).length, 1);
});

test("an active turn renders a live install command before history reloads", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: { id: "turn-1", status: "inProgress", items: [] },
      index: 1,
      thread,
      streamed: [],
      streamedItems: [
        {
          itemId: "command-1",
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "npm install -D @playwright/test",
            status: "inProgress",
          },
        },
      ],
    }),
  );

  assert.match(html, /正在执行/);
  assert.match(html, /npm install -D @playwright\/test/);
});

test("normalized history ids do not duplicate completed streamed messages", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
  };
  const text = "第一轮补丁只应显示一次";
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: {
        id: "turn-1",
        status: "inProgress",
        items: [
          { id: "item-20", type: "agentMessage", phase: "commentary", text },
        ],
      },
      index: 1,
      thread,
      streamed: [{ itemId: "msg-runtime-id", text, completed: true }],
    }),
  );

  assert.equal(html.split(text).length - 1, 1);
  assert.equal((html.match(/message agent/g) || []).length, 1);
});

test("a persisted Claude message stays before its following tool while streaming", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "claude-current",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "sonnet",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
    agentId: "claude",
  };
  const text = "Let me search the project styles for the provider row.";
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: {
        id: "turn-1",
        status: "inProgress",
        items: [
          {
            id: "history-message",
            type: "agentMessage",
            text: `${text} Done.`,
          },
          {
            id: "tool-1",
            type: "commandExecution",
            command: "rg provider-row",
            status: "completed",
          },
        ],
      },
      index: 1,
      thread,
      streamed: [{ itemId: "live-api-id", text }],
    }),
  );

  assert.equal(html.split(text).length - 1, 1);
  assert.ok(html.indexOf(text) < html.indexOf("rg provider-row"));
});

test("an optimistic steer is inserted before commands that arrive after it", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: {
        id: "turn-1",
        status: "inProgress",
        items: [
          { id: "user-1", type: "userMessage", text: "开始" },
          {
            id: "old-command",
            type: "commandExecution",
            command: "rg 旧命令",
            status: "completed",
          },
        ],
      },
      index: 1,
      thread,
      streamed: [],
      streamedItems: [
        {
          itemId: "old-command",
          item: {
            id: "old-command",
            type: "commandExecution",
            command: "rg 旧命令",
            status: "completed",
          },
        },
        {
          itemId: "new-command",
          item: {
            id: "new-command",
            type: "commandExecution",
            command: "rg 新命令",
            status: "inProgress",
          },
        },
      ],
      pendingUsers: [
        {
          id: "pending-1",
          text: "追加消息",
          images: [],
          loadedUserMessageCount: 1,
          turnId: "turn-1",
          liveItemIds: ["old-command"],
        },
      ],
    }),
  );

  assert.ok(html.indexOf("rg 旧命令") < html.indexOf("追加消息"));
  assert.ok(html.indexOf("追加消息") < html.indexOf("rg 新命令"));
});

test("live messages interleave with live items in event order", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
    agentId: "devin",
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: { id: "turn-1", status: "inProgress", items: [] },
      index: 1,
      thread,
      streamed: [
        { itemId: "msg-1", text: "第一段" },
        { itemId: "msg-2", text: "第二段" },
      ],
      streamedItems: [
        {
          itemId: "tool-1",
          item: {
            id: "tool-1",
            type: "commandExecution",
            command: "echo one",
            status: "completed",
          },
        },
        {
          itemId: "tool-2",
          item: {
            id: "tool-2",
            type: "commandExecution",
            command: "echo two",
            status: "completed",
          },
        },
      ],
      streamedEntries: [
        { kind: "message", itemId: "msg-1" },
        { kind: "item", itemId: "tool-1" },
        { kind: "message", itemId: "msg-2" },
        { kind: "item", itemId: "tool-2" },
      ],
    }),
  );

  const order = ["第一段", "echo one", "第二段", "echo two"].map((text) =>
    html.indexOf(text),
  );
  assert.ok(
    order.every((pos) => pos >= 0) &&
      order[0] < order[1] &&
      order[1] < order[2] &&
      order[2] < order[3],
    `expected interleaved order, got ${order.join(",")}`,
  );
});

test("history user messages expose retry-from-here instead of append resend", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "idle",
    updatedAt: Date.now(),
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ id: "user-1", type: "userMessage", text: "再试一次" }],
      },
      index: 1,
      thread,
      streamed: [],
      onRetryUserMessage: () => undefined,
    }),
  );

  assert.match(html, /从此重试/);
  assert.doesNotMatch(html, />重发</);
});

test("search targets mark the exact message instead of the whole turn", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "idle",
    updatedAt: Date.now(),
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "user-1", type: "userMessage", text: "问题" },
          { id: "agent-1", type: "agentMessage", text: "精确答案" },
        ],
      },
      index: 1,
      thread,
      streamed: [],
      targetItemId: "agent-1",
      targetRequest: 7,
    }),
  );

  assert.match(html, /class="search-item-target" data-item-id="agent-1"/);
  assert.doesNotMatch(html, /turn-block[^\"]*search-target/);
  assert.equal(html.split('class="search-item-target"').length - 1, 1);
});
