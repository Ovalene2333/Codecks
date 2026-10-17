import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRegistry } from "./agents/registry.js";
import { AgentMessageError, assertMessageInput, messageBusy, type AgentMessageInput } from "./agents/messages.js";
import { MessageDeliveryQueue } from "./message-delivery.js";

class Transport extends EventEmitter {
  thread = { id: "t", agentId: "agent", providerId: "p", status: "running", activeTurnId: "old", compacting: false, archived: false } as any;
  online = true;
  cleanupReady = true;
  sent: AgentMessageInput[] = [];
  interrupted: string[] = [];
  holds = 0;
  onInterrupt?: () => void;
  onSend?: () => void;
  constructor(readonly behavior: "steer" | "reject" | "queue" | "unknown") { super(); }
  messageBackendOnline() { return this.online; }
  messageState() {
    return {
      thread: this.thread, online: this.online,
      ready: !messageBusy(this.thread) && !this.thread.compacting && this.cleanupReady,
      capabilities: { interrupt: true, messages: {
        busyBehavior: this.behavior, interruptScope: "session" as const,
        deliveryModes: ["queue", "feedback"],
      } },
    };
  }
  async sendMessage(_agent: string, _thread: string, input: AgentMessageInput) {
    assertMessageInput(this.thread, input, this.messageState().capabilities.messages);
    this.sent.push(input);
    this.onSend?.();
    if (input.mode === "start") {
      this.thread.status = "running";
      this.thread.activeTurnId = `turn-${this.sent.length}`;
    }
    return { id: "receipt", status: "accepted", disposition: input.mode === "append" ? "appended" : "started", turnId: this.thread.activeTurnId };
  }
  async interruptMessage(_agent: string, _thread: string, expected: string) {
    assert.equal(this.thread.activeTurnId, expected);
    this.interrupted.push(expected);
    this.onInterrupt?.();
  }
  holdMessageQueue() {
    this.holds++;
    return () => { this.holds--; };
  }
  finish() {
    this.thread.status = "idle";
    this.thread.activeTurnId = undefined;
    this.emit("event", { type: "thread.updated", data: this.thread });
  }
}

async function fixture(t: any, behavior: ConstructorParameters<typeof Transport>[0], timeout = 300) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-message-delivery-"));
  const transport = new Transport(behavior);
  const file = path.join(dir, "messages.json");
  const deliveries = new MessageDeliveryQueue({ file, agents: transport as unknown as AgentRegistry, timer: false, interruptTimeoutMs: timeout });
  await deliveries.load();
  t.after(async () => { deliveries.close(); await rm(dir, { recursive: true, force: true }); });
  return { transport, deliveries, file };
}

test("all backends provide queue with FIFO independent of native busy behavior", async (t) => {
  for (const behavior of ["steer", "reject", "queue", "unknown"] as const) {
    const { transport, deliveries, file } = await fixture(t, behavior);
    await deliveries.enqueue("agent", "t", "queue", { text: "first", images: [{ url: "data:image/png;base64,a" }] });
    await deliveries.enqueue("agent", "t", "queue", { text: "second" });
    await deliveries.tick();
    assert.equal(transport.sent.length, 0);
    assert.equal(JSON.parse(await readFile(file, "utf8")).items.length, 2, "受理前已落盘");
    transport.finish();
    await deliveries.tick();
    assert.equal(transport.sent[0].mode, "start");
    assert.equal(transport.sent[0].text, "first");
    assert.equal(transport.sent[0].images?.length, 1);
    await deliveries.tick();
    assert.equal(transport.sent.length, 1);
    transport.finish();
    await deliveries.tick();
    assert.equal(transport.sent[1].text, "second");
  }
});

test("feedback steers without interrupting and takes priority over queued work", async (t) => {
  const { transport, deliveries } = await fixture(t, "steer");
  await deliveries.enqueue("agent", "t", "queue", { text: "later" });
  await deliveries.enqueue("agent", "t", "feedback", { text: "now" });
  await deliveries.tick();
  assert.equal(transport.sent[0].mode, "append");
  assert.equal(transport.sent[0].expectedTurnId, "old");
  assert.equal(transport.sent[0].text, "now");
  assert.equal(transport.interrupted.length, 0);
  assert.equal(deliveries.list()[0].status, "queued");
});

test("a queued bubble is promoted durably in place on every backend without duplicate sends", async (t) => {
  for (const behavior of ["steer", "reject", "queue", "unknown"] as const) {
    const { transport, deliveries, file } = await fixture(t, behavior);
    const first = await deliveries.enqueue("agent", "t", "queue", { text: "later" });
    const second = await deliveries.enqueue("agent", "t", "queue", {
      text: "intervene", images: [{ url: "data:image/png;base64,a" }],
    });
    const promotion = deliveries.feedback(second.id, "agent", "t");
    const duplicate = deliveries.feedback(second.id, "agent", "t");
    await deliveries.tick();
    assert.equal(transport.sent.length, 0, "提升落盘前不得投递");
    const [receipt, repeated] = await Promise.all([promotion, duplicate]);
    assert.equal(receipt.id, second.id);
    assert.equal(repeated.id, second.id);
    const stored = JSON.parse(await readFile(file, "utf8")).items;
    assert.equal(stored.length, 2);
    assert.equal(stored[1].mode, "feedback");
    assert.equal(stored[1].input.images[0].url, "data:image/png;base64,a");
    transport.onInterrupt = () => transport.finish();
    await deliveries.tick();
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].text, "intervene");
    assert.equal(transport.sent[0].mode, behavior === "steer" ? "append" : "start");
    assert.equal(transport.interrupted.length, behavior === "steer" ? 0 : 1);
    assert.equal(deliveries.list().find((item) => item.id === first.id)?.status, "queued");
    await deliveries.feedback(second.id, "agent", "t");
    await deliveries.tick();
    assert.equal(transport.sent.length, 1, "重复点击已提升的气泡不能创建第二条消息");
  }
});

test("promotion rejects wrong targets, failed records and messages already being sent", async (t) => {
  const { transport, deliveries } = await fixture(t, "steer");
  const item = await deliveries.enqueue("agent", "t", "queue", { text: "once" });
  await assert.rejects(deliveries.feedback(item.id, "other", "t"), { statusCode: 404 });
  await assert.rejects(deliveries.feedback(item.id, "agent", "other"), { statusCode: 404 });
  transport.finish();
  let release!: () => void;
  let began!: () => void;
  const sending = new Promise<void>((resolve) => { began = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const send = transport.sendMessage.bind(transport);
  transport.sendMessage = async (...args: Parameters<typeof send>) => {
    const result = await send(...args);
    began();
    await held;
    return result;
  };
  const dispatch = deliveries.tick();
  await sending;
  await assert.rejects(deliveries.feedback(item.id, "agent", "t"), { code: "busy" });
  release();
  await dispatch;
  await assert.rejects(deliveries.feedback(item.id, "agent", "t"), { code: "busy" });
  assert.equal(transport.sent.length, 1);
  transport.onSend = () => { throw new Error("unknown acceptance"); };
  transport.finish();
  const failed = await deliveries.enqueue("agent", "t", "queue", { text: "failed" });
  await deliveries.tick();
  await assert.rejects(deliveries.feedback(failed.id, "agent", "t"), { code: "busy" });
});

test("cancelling during promotion never resurrects or sends the message", async (t) => {
  const { transport, deliveries, file } = await fixture(t, "steer");
  const item = await deliveries.enqueue("agent", "t", "queue", { text: "cancel" });
  const promoting = deliveries.feedback(item.id, "agent", "t");
  const cancelling = deliveries.cancel(item.id, "agent", "t");
  await assert.rejects(promoting, { statusCode: 404 });
  await cancelling;
  await deliveries.tick();
  assert.deepEqual(deliveries.list(), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).items, []);
  assert.equal(transport.sent.length, 0);
});

test("pending bubbles expose full text and image count without image data in snapshots", async (t) => {
  const { transport, deliveries } = await fixture(t, "steer");
  const text = "long instruction ".repeat(100);
  await deliveries.enqueue("agent", "t", "queue", { text, images: [{ url: "data:image/png;base64,a" }] });
  const pending = deliveries.list()[0];
  assert.equal(pending.text, text);
  assert.equal(pending.preview.length, 300);
  assert.equal(pending.imageCount, 1);
  assert.equal("input" in pending, false);
  assert.equal(JSON.stringify(pending).includes("data:image"), false);
  transport.finish();
  await deliveries.tick();
  const delivered = deliveries.list()[0];
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.text, text, "受理后保留全文直到前端加载聊天记录");
  assert.equal(delivered.imageCount, 1);
  assert.equal(JSON.stringify(delivered).includes("data:image"), false);
});

test("feedback interrupts other backends and waits for confirmed idle and adapter cleanup", async (t) => {
  for (const behavior of ["reject", "queue", "unknown"] as const) {
    const { transport, deliveries } = await fixture(t, behavior);
    let began!: () => void;
    const interrupted = new Promise<void>((resolve) => { began = resolve; });
    transport.onInterrupt = began;
    await deliveries.enqueue("agent", "t", "feedback", { text: "new instruction" });
    const dispatch = deliveries.tick();
    await interrupted;
    assert.equal(transport.sent.length, 0);
    assert.equal(transport.holds, 1);
    transport.cleanupReady = false;
    transport.finish();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    assert.equal(transport.sent.length, 0, "摘要空闲时还要等待 adapter 清理完成");
    transport.cleanupReady = true;
    await dispatch;
    assert.equal(transport.sent[0].mode, "start");
    assert.equal(transport.holds, 0);
    assert.equal(deliveries.list()[0].status, "delivered");
  }
});

test("unconfirmed interruption preserves a failed message without sending", async (t) => {
  const { transport, deliveries } = await fixture(t, "reject", 50);
  await deliveries.enqueue("agent", "t", "feedback", { text: "keep me" });
  await deliveries.tick();
  assert.equal(transport.sent.length, 0);
  assert.equal(deliveries.list()[0].status, "failed");
  assert.equal(deliveries.list()[0].canRetry, true);
  assert.match(deliveries.list()[0].error!, /未能确认/);
  assert.equal(transport.holds, 0);
});

test("another active turn is never interrupted or overwritten by stale feedback", async (t) => {
  const { transport, deliveries } = await fixture(t, "unknown");
  await deliveries.enqueue("agent", "t", "feedback", { text: "feedback" });
  transport.thread.activeTurnId = "other";
  await deliveries.tick();
  assert.equal(transport.interrupted.length, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(deliveries.list()[0].status, "failed");
});

test("cancelling while waiting releases the queue hold and never sends the message", async (t) => {
  const { transport, deliveries } = await fixture(t, "queue");
  let began!: () => void;
  const interrupted = new Promise<void>((resolve) => { began = resolve; });
  transport.onInterrupt = began;
  const item = await deliveries.enqueue("agent", "t", "feedback", { text: "cancel me" });
  const dispatch = deliveries.tick();
  await interrupted;
  await deliveries.cancel(item.id, "agent", "t");
  transport.finish();
  await dispatch;
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.holds, 0);
  assert.deepEqual(deliveries.list(), []);
});

test("queued messages survive restart; interrupted and unknown sending states are recovered separately", async (t) => {
  const { transport, deliveries, file } = await fixture(t, "steer");
  const queued = await deliveries.enqueue("agent", "t", "queue", { text: "survive" });
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.items.push({ ...stored.items[0], id: "interrupting", status: "interrupting" });
  stored.items.push({ ...stored.items[0], id: "sending", status: "sending" });
  await writeFile(file, JSON.stringify(stored));
  deliveries.close();
  const restored = new MessageDeliveryQueue({ file, agents: transport as unknown as AgentRegistry, timer: false });
  t.after(() => restored.close());
  await restored.load();
  const records = restored.list();
  assert.equal(records.find((item) => item.id === queued.id)?.status, "queued");
  assert.equal(records.find((item) => item.id === "interrupting")?.canRetry, true);
  assert.equal(records.find((item) => item.id === "sending")?.canRetry, false);
  await assert.rejects(restored.retry("sending", "agent", "t"), /不能自动重试/);
  transport.finish();
  await restored.tick();
  assert.equal(transport.sent[0].text, "survive");
  await restored.tick();
  assert.equal(transport.sent.length, 1);
});

test("ambiguous backend failures are not automatically retried", async (t) => {
  const { transport, deliveries } = await fixture(t, "steer");
  transport.finish();
  transport.onSend = () => { throw new Error("connection closed after acceptance"); };
  const item = await deliveries.enqueue("agent", "t", "queue", { text: "once" });
  await deliveries.tick();
  assert.equal(deliveries.list()[0].canRetry, false);
  await deliveries.tick();
  assert.equal(transport.sent.length, 1);
  await assert.rejects(deliveries.retry(item.id, "agent", "t"), /不能自动重试/);
});

test("offline backends preserve the queue until they are online", async (t) => {
  const { transport, deliveries } = await fixture(t, "reject");
  transport.finish();
  await deliveries.enqueue("agent", "t", "queue", { text: "wait for backend" });
  transport.online = false;
  await deliveries.tick();
  assert.equal(deliveries.list()[0].status, "queued");
  assert.equal(transport.sent.length, 0);
  transport.online = true;
  await deliveries.tick();
  assert.equal(transport.sent.length, 1);
});
