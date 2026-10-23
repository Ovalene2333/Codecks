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

test("running steerable sessions offer a send menu; other transports keep direct queue sending", () => {
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
    if (busyBehavior === "steer") {
      assert.match(html, /aria-label="选择发送方式"/);
      assert.match(html, /aria-haspopup="menu"/);
    } else {
      assert.match(html, /class="prompt-input__button send" title="排队"/);
      assert.doesNotMatch(html, /aria-label="选择发送方式"/);
    }
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

test("queued messages appear as user bubbles in the timeline with full text and promotion actions", () => {
  const html = renderToStaticMarkup(createElement(Timeline, {
    thread, turns: [], streamed: [], streamedItems: [], streamedEntries: [], pendingUsers: [],
    messageDeliveries: [item], onDeliveryCancel: action, onDeliveryFeedback: action,
    feedbackInterrupts: true, targetFallbackReady: true,
  }));
  assert.ok(html.includes(item.text!));
  assert.match(html, /class="message user"/);
  assert.match(html, /aria-label="已排队，等待当前任务结束"/);
  assert.match(html, /aria-label="即时反馈"/);
  assert.match(html, /aria-label="取消"/);
  assert.match(html, /2 张图片/);
  assert.match(html, /即时反馈：先停止当前任务/);
  assert.doesNotMatch(html, /session-empty/);
});

test("only queued append bubbles expose promotion; in-flight and failed records show their actual state", () => {
  const render = (record: MessageDelivery, supportsFeedback = true) => renderToStaticMarkup(createElement(MessageQueue, {
    items: [record], onFeedback: supportsFeedback ? action : undefined, onCancel: action, onRetry: action,
  }));
  assert.doesNotMatch(render(item, false), /aria-label="即时反馈"/);
  assert.doesNotMatch(render({ ...item, mode: "feedback" }), /aria-label="即时反馈"/);
  const sending = render({ ...item, status: "sending" });
  assert.match(sending, /正在发送/);
  assert.doesNotMatch(sending, /aria-label="即时反馈"|aria-label="取消"/);
  const delivered = render({ ...item, status: "delivered" });
  assert.match(delivered, /已发送|正在同步聊天记录/);
  assert.doesNotMatch(delivered, /aria-label="即时反馈"|aria-label="取消"|aria-label="重试"/);
  const stopping = render({ ...item, mode: "feedback", status: "interrupting" });
  assert.match(stopping, /正在停止当前任务/);
  assert.doesNotMatch(stopping, /aria-label="即时反馈"/);
  const unknown = render({ ...item, status: "failed", error: "无法确认是否已受理", canRetry: false });
  assert.match(unknown, /无法确认是否已受理/);
  assert.doesNotMatch(unknown, /aria-label="重试"|aria-label="即时反馈"/);
  const unsent = render({ ...item, status: "failed", canRetry: true });
  assert.match(unsent, /aria-label="重试"/);
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
