import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentCapabilities, MessageDelivery, ThreadSummary } from "../types";
import { Composer } from "./Composer";
import { MessageQueue } from "./MessageQueue";
import { Timeline } from "./Timeline";

const thread: ThreadSummary = {
  id: "t", agentId: "claude", providerId: "p", cwd: "/work", name: "Test", preview: "",
  model: "test", status: "running", activeTurnId: "old", updatedAt: 1,
};
const item: MessageDelivery = {
  id: "queued", agentId: "claude", threadId: "t", mode: "queue", status: "queued",
  preview: "消息预览", text: "待发送的完整消息".repeat(100), imageCount: 2,
  createdAt: 1, updatedAt: 1,
};
const noop = () => {};
const action = async () => {};

test("inbox batches are not editable user drafts", () => {
  const html = renderToStaticMarkup(createElement(MessageQueue, {
    items: [{ ...item, owner: "deck-inbox", inboxBatchId: "batch" }], onEdit: action, onCancel: action, onRetry: action,
  }));
  assert.doesNotMatch(html, /session-message-queue-item|>编辑<|>取消</);
});

test("running sessions with queue and feedback offer a send mode menu", () => {
  for (const busyBehavior of ["steer", "reject", "queue", "unknown"] as const) {
    const capabilities = { interrupt: true, messages: {
      busyBehavior, interruptScope: "session", deliveryModes: ["queue", "feedback"],
    } } as AgentCapabilities;
    const html = renderToStaticMarkup(createElement(Composer, {
      thread, capabilities, text: "继续", images: [], sending: false,
      onChange: noop, onImages: noop, onSend: noop, onCommand: noop, onStop: noop,
    }));
    assert.match(html, /data-slot="prompt-input"/);
    assert.match(html, /data-slot="prompt-input-footer"/);
    assert.doesNotMatch(html, /composer-sendmode/);
    assert.match(html, /aria-label="选择发送方式"/);
    assert.match(html, /aria-haspopup="menu"/);
    assert.doesNotMatch(html, /class="prompt-input__button send" title="排队"/);
  }
});

test("composer keeps secondary session settings behind one icon button", () => {
  const html = renderToStaticMarkup(createElement(Composer, {
    thread, capabilities: { sessionSettings: true } as AgentCapabilities,
    text: "", images: [], sending: false, onSessionSettings: noop,
    onChange: noop, onImages: noop, onSend: noop, onCommand: noop, onStop: noop,
  }));
  assert.match(html, /aria-label="添加图片"/);
  assert.match(html, /aria-label="会话设置"/);
  assert.doesNotMatch(html, /发送说明|composer-model-trigger|composer-session-controls/);
});

test("queued messages appear as user bubbles with edit and cancel on the status row", () => {
  const html = renderToStaticMarkup(createElement(Timeline, {
    thread, turns: [], streamed: [], streamedItems: [], streamedEntries: [], pendingUsers: [],
    messageDeliveries: [item], onDeliveryCancel: action, onDeliveryEdit: action,
    onDeliveryRetry: action, targetFallbackReady: true,
  }));
  assert.ok(html.includes(item.text!));
  assert.match(html, /class="message user"/);
  assert.match(html, /aria-label="已排队，等待当前任务结束"/);
  assert.match(html, />编辑</);
  assert.match(html, /编辑：从队列取回/);
  assert.match(html, />取消</);
  assert.match(html, /取消排队，不会放回输入框/);
  assert.doesNotMatch(html, /即时反馈/);
  assert.match(html, /2 张图片/);
  assert.doesNotMatch(html, /session-empty/);
});

test("edit only applies to queued records; sending and delivered hide actions", () => {
  const render = (record: MessageDelivery) => renderToStaticMarkup(createElement(MessageQueue, {
    items: [record], onEdit: action, onCancel: action, onRetry: action,
  }));
  assert.match(render(item), />编辑</);
  assert.match(render({ ...item, mode: "feedback" }), />编辑</);
  const sending = render({ ...item, status: "sending" });
  assert.match(sending, /正在发送/);
  assert.doesNotMatch(sending, />编辑<|>取消</);
  const delivered = render({ ...item, status: "delivered" });
  assert.match(delivered, /已发送|正在同步聊天记录/);
  assert.doesNotMatch(delivered, />编辑<|>取消<|重试/);
  const stopping = render({ ...item, mode: "feedback", status: "interrupting" });
  assert.match(stopping, /正在停止当前任务/);
  assert.doesNotMatch(stopping, />编辑</);
  const unknown = render({ ...item, status: "failed", error: "无法确认是否已受理", canRetry: false });
  assert.match(unknown, /无法确认是否已受理/);
  assert.match(unknown, />移除</);
  assert.doesNotMatch(unknown, /重试|>编辑</);
  const unsent = render({ ...item, status: "failed", canRetry: true });
  assert.match(unsent, /重试/);
  // 排队中的 Deck 注入消息不叫“你”，说话人直接标推送类型。
  const pushed = render({ ...item, text: "[wake:abc123] [job] 任务结束" });
  assert.match(pushed, /message-block__who">唤醒推送</);
  assert.doesNotMatch(pushed, /message-block__who">你</);
  const sent = render({ ...item, text: "[send:abcd1234] 补充上下文" });
  assert.match(sent, /message-block__who">消息推送</);
  const ask = render({ ...item, text: "[ask:7f3a2c] 结论：用 B" });
  assert.match(ask, /message-block__who">询问回传</);
  const human = render(item);
  assert.match(human, /message-block__who">你</);
});
