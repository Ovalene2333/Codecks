import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageDelivery, ThreadSummary } from "../types";
import { Timeline } from "./Timeline";
import { loadedUserMessages } from "./user-message-reconcile";
import { reconcileTimelineMessages } from "./timeline-messages";

const thread: ThreadSummary = {
  id: "t",
  agentId: "codex",
  providerId: "p",
  cwd: "/work",
  name: "Test",
  preview: "",
  model: "test",
  status: "idle",
  updatedAt: 1,
};
const turn = (id: string, text: string) => ({
  id,
  status: "completed",
  items: [
    {
      id: `user-${id}`,
      type: "userMessage",
      content: [{ type: "text", text }],
    },
    { id: `agent-${id}`, type: "agentMessage", text: `reply-${id}` },
  ],
});
const delivery = (
  id: string,
  text: string,
  createdAt: number,
): MessageDelivery => ({
  id,
  text,
  preview: text,
  createdAt,
  updatedAt: createdAt,
  agentId: "codex",
  threadId: "t",
  mode: "queue",
  status: "delivered",
  turnId: id,
  imageCount: 0,
});
const render = (turns: any[], deliveries: MessageDelivery[], overrides = {}) =>
  renderToStaticMarkup(
    createElement(Timeline, {
      thread,
      turns,
      messageDeliveries: deliveries,
      streamed: [],
      streamedItems: [],
      streamedEntries: [],
      pendingUsers: [],
      ...overrides,
    }),
  );
const count = (html: string, text: string) => html.split(text).length - 1;

test("entering a session before its history loads never renders an archive of sent messages at the bottom", () => {
  const records = [
    delivery("new", "NEW-USER-TEXT", 3),
    delivery("old", "OLD-USER-TEXT", 1),
  ];
  for (const turns of [[], [turn("tail", "CACHED-TAIL")]]) {
    const html = render(turns, records);
    assert.equal(count(html, "NEW-USER-TEXT"), 0);
    assert.equal(count(html, "OLD-USER-TEXT"), 0);
    assert.doesNotMatch(html, /session-message-queue-item/);
  }
  const html = render(
    [turn("old", "OLD-USER-TEXT"), turn("new", "NEW-USER-TEXT")],
    records,
  );
  assert.equal(count(html, "OLD-USER-TEXT"), 1);
  assert.equal(count(html, "NEW-USER-TEXT"), 1);
  assert.ok(html.indexOf("OLD-USER-TEXT") < html.indexOf("NEW-USER-TEXT"));
});

test("genuine pending messages keep oldest-to-newest order even when snapshots are reversed", () => {
  const records = [
    delivery("new", "NEW-PENDING", 3),
    delivery("old", "OLD-PENDING", 1),
  ].map((item) => ({ ...item, status: "queued" as const }));
  const html = render([], records);
  assert.equal(count(html, "OLD-PENDING"), 1);
  assert.equal(count(html, "NEW-PENDING"), 1);
  assert.ok(html.indexOf("OLD-PENDING") < html.indexOf("NEW-PENDING"));
});

test("streamed user messages take over local and delivered bubbles before transcript fetch completes", () => {
  const record = delivery("active", "LIVE-USER-TEXT", 1);
  const active = {
    ...thread,
    status: "running" as const,
    activeTurnId: "active",
  };
  const pending = {
    id: "local",
    text: record.text!,
    images: [],
    historyBefore: [],
    turnId: "active",
  };
  const streamed = [
    {
      itemId: "live-user",
      item: { id: "live-user", type: "userMessage", text: record.text },
    },
  ];
  const html = render([], [record], {
    thread: active,
    pendingUsers: [pending],
    streamedItems: streamed,
    streamedEntries: [{ kind: "item", itemId: "live-user" }],
  });
  assert.equal(count(html, "LIVE-USER-TEXT"), 1);
  assert.doesNotMatch(
    html,
    /session-message-queue-item|optimistic-user-message/,
  );
});

test("a snapshot arriving before the POST response takes over the local bubble once", () => {
  const record = {
    ...delivery("receipt", "SNAPSHOT-FIRST", 1),
    status: "queued" as const,
  };
  const pending = {
    id: "local",
    text: record.text!,
    images: [],
    historyBefore: [],
    deliveryIdsBefore: [],
  };
  const html = render([], [record], { pendingUsers: [pending] });
  assert.equal(count(html, "SNAPSHOT-FIRST"), 1);
  assert.doesNotMatch(html, /optimistic-turn/);
});

test("an older identical queued message cannot swallow a new local send", () => {
  const old = { ...delivery("old", "重复正文", 1), status: "queued" as const };
  const pending = {
    id: "local",
    text: old.text!,
    images: [],
    historyBefore: [],
    deliveryIdsBefore: [old.id],
  };
  const result = reconcileTimelineMessages(thread, [], [], [pending], [old]);
  assert.equal(result.pendingUsers.length, 1);
  assert.equal(result.messageDeliveries.length, 1);
});

test("history growth, reordering and cache truncation do not change message ownership", () => {
  const old = turn("old", "已存在");
  const pending = {
    id: "local",
    text: "本次发送",
    images: [],
    historyBefore: loadedUserMessages([old]),
    turnId: "new",
  };
  for (const turns of [
    [turn("new", pending.text), old],
    [turn("new", pending.text)],
  ]) {
    assert.deepEqual(
      reconcileTimelineMessages(thread, turns, [], [pending], []).pendingUsers,
      [],
    );
  }
});

test("ACP restored history and legacy attachment echoes never create duplicate bottom bubbles", () => {
  const acp = {
    ...thread,
    agentId: "devin",
    status: "running" as const,
    activeTurnId: "live",
  };
  const record = {
    ...delivery("live", "ACP-USER-TEXT", 1),
    agentId: "devin",
    imageCount: 1,
  };
  for (const text of ["ACP-USER-TEXT", "ACP-USER-TEXT[image]"]) {
    const html = render([turn("acp-replay-1", text)], [record], {
      thread: acp,
    });
    assert.equal(count(html, "ACP-USER-TEXT"), 1);
    assert.doesNotMatch(html, /session-message-queue-item/);
  }
});
