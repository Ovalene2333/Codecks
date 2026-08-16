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
