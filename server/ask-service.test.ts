import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AskService } from "./ask-service.js";
import { MessageDeliveryQueue } from "./message-delivery.js";
import { WakeOutbox } from "./wake-outbox.js";
import type { AgentRegistry } from "./agents/registry.js";
import type { ThreadSummary } from "./types.js";

class Agents extends EventEmitter {
  threads = new Map<string, ThreadSummary>();
  turns = new Map<string, any[]>();
  sends: { id: string; text: string; mode: string }[] = [];
  interrupts: string[] = [];
  constructor() {
    super();
    this.threads.set("source", { id: "source", agentId: "demo", providerId: "acme", cwd: "/work/demo", status: "running", activeTurnId: "original" } as ThreadSummary);
  }
  async createThread(agentId: string, input: any) {
    const id = `target-${this.threads.size}`;
    const thread = { ...input, id, agentId, providerId: "acme", status: "idle", updatedAt: Date.now() } as ThreadSummary;
    this.threads.set(id, thread); return thread;
  }
  enabled = true;
  online = true;
  list() { return [{ id: "demo-review", online: this.online, enabled: this.enabled }]; }
  messageBackendOnline() { return this.online; }
  messageState(_agentId: string, id: string) {
    const thread = this.threads.get(id)!;
    return { thread, online: true, ready: thread.status === "idle", capabilities: {
      interrupt: true, messages: { busyBehavior: "steer", interruptScope: "turn", deliveryModes: ["queue", "feedback"] },
    } };
  }
  async sendMessage(_agentId: string, id: string, input: any) {
    this.sends.push({ id, text: input.text, mode: input.mode });
    const thread = this.threads.get(id)!;
    thread.status = "running"; thread.activeTurnId = `turn-${this.sends.length}`;
    return { disposition: "started", turnId: thread.activeTurnId };
  }
  holdMessageQueue() { return () => {}; }
  async interruptMessage(_agent: string, id: string, expected: string) {
    assert.equal(this.threads.get(id)?.activeTurnId, expected);
    this.interrupts.push(id); this.finish(id);
  }
  async readThread(_agent: string, id: string) { return { turns: this.turns.get(id) || [] }; }
  finish(id: string, answer = "demo answer", status = "completed") {
    const thread = this.threads.get(id)!;
    this.turns.set(id, [{ id: thread.activeTurnId, status, items: [{ type: "agentMessage", text: answer }] }]);
    thread.status = "idle"; thread.activeTurnId = undefined;
  }
}

async function fixture(t: any) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-ask-test-"));
  const fake = new Agents();
  const agents = fake as unknown as AgentRegistry;
  const messages = new MessageDeliveryQueue({ file: path.join(dir, "messages.json"), agents, timer: false });
  await messages.load();
  const wake = new WakeOutbox({ file: path.join(dir, "wake.json"), timer: false,
    resolve: () => ({ agentId: "demo", threadId: "source" }),
    send: async (agentId, threadId, text, delivery) => messages.enqueue(agentId, threadId,
      delivery.mode === "interrupt" ? "feedback" : "queue", { text },
      { id: `wake:${delivery.id}`, forceInterrupt: delivery.mode === "interrupt" }),
  });
  await wake.load();
  const options = { file: path.join(dir, "asks.json"), agents, messages, wake, timer: false as const };
  const service = new AskService(options); await service.load();
  t.after(async () => { service.close(); messages.close(); wake.close(); await rm(dir, { recursive: true, force: true }); });
  const create = (returnMode: "queue" | "interrupt" = "queue") => service.create({
    sourceAgentId: "demo", sourceThreadId: "source", targetAgentId: "demo-review",
    question: 'Review "demo"\nwith context', wakeCode: "demo-wake", returnMode,
    settings: { cwd: "/work/demo", providerId: "acme" },
  });
  return { fake, service, messages, wake, create, options };
}

test("each ask creates a distinct native session and persists its source association", async (t) => {
  const { create, service } = await fixture(t);
  const a = await create(); const b = await create();
  assert.notEqual(a.thread.id, b.thread.id);
  assert.notEqual(a.item.id, b.item.id);
  assert.equal(a.thread.ask?.sourceThreadId, "source");
  assert.equal(a.thread.ask?.sourceProviderId, "acme");
  assert.equal(service.list().length, 2);
});

test("completion without send stays silent toward the source", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  assert.equal(service.list()[0].status, "running");
  fake.finish(thread.id);
  await service.tick(); await wake.tick(); await messages.tick();
  assert.equal(service.list()[0].status, "completed");
  // 纯双向通信：只有最初的问题送达，完成本身不产生任何通知。
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.interrupts.length, 0);
  assert.equal(wake.list().length, 0);
  assert.doesNotMatch(fake.sends[0].text, /demo answer/);
});

test("interrupt return stops even a steer-capable source and starts a new turn", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create("interrupt");
  await messages.tick(); await service.tick();
  await service.sendFrom("demo-review", thread.id, "Interrupting update");
  await wake.tick(); await messages.tick();
  assert.deepEqual(fake.interrupts, ["source"]);
  assert.equal(fake.sends[1].mode, "start");
});

test("restart recovers completed target history without asking or replying twice", async (t) => {
  const { create, fake, service, messages, wake, options } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick(); service.close();
  fake.finish(thread.id);
  const restored = new AskService(options); await restored.load();
  await restored.tick(); await restored.tick();
  assert.equal(wake.list().length, 0);
  assert.equal(messages.list().length, 1);
  assert.equal(restored.list()[0].status, "completed");
  restored.close();
});

test("failed target turn returns a failure message, rather than a successful answer", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick(); fake.finish(thread.id, "", "failed");
  await service.tick(); await wake.tick(); fake.finish("source"); await messages.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(fake.sends[1].text, /询问失败/);
});

test("cancelled question is reported through the same callback path", async (t) => {
  const { create, service, messages, wake } = await fixture(t);
  const { item, thread } = await create();
  await messages.cancel(item.deliveryId!, "demo-review", thread.id);
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.equal(wake.list().length, 1);
  assert.match(wake.list()[0].preview, /已被取消/);
});

test("completion forwards neither final answer nor commentary", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick(); fake.finish(thread.id);
  fake.turns.get(thread.id)![0].items = [
    { type: "agentMessage", phase: "commentary", text: "intermediate-only" },
    { type: "agentMessage", phase: "final_answer", text: "final conclusion" },
  ];
  await service.tick(); await wake.tick(); await messages.tick();
  // 没有隐式转发路径：完成后的会话内容（包括最终回答）不会到达来源。
  assert.equal(fake.sends.length, 1);
  assert.equal(wake.list().length, 0);
});


test("launch failure without a transcript returns its error even after backend goes offline", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  const turnId = fake.threads.get(thread.id)!.activeTurnId;
  fake.online = false;
  fake.emit("event", { type: "agent.event", data: { agentId: "demo-review", method: "turn/completed",
    params: { threadId: thread.id, turn: { id: turnId, status: "failed", error: { message: "Demo native executable not found" } } } } });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(wake.list()[0].preview, /Demo native executable not found/);
  assert.equal(fake.turns.has(thread.id), false);
  await service.tick(); assert.equal(wake.list().length, 1);
});

test("error summary without a persisted turn is terminal, even when not ready", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  Object.assign(fake.threads.get(thread.id)!, { status: "error", activeTurnId: undefined, lastError: "Demo launcher failed" });
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(wake.list()[0].preview, /Demo launcher failed/);
});

test("disabling the target records failure without waking the source", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  await create(); await messages.tick(); await service.tick();
  fake.enabled = false; fake.online = false;
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(service.list()[0].error!, /已停用/);
  assert.equal(wake.list().length, 0);
  await service.tick();
  assert.equal(wake.list().length, 0);
});


test("bound send supports multiple messages and completion never dumps final text", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create("interrupt");
  await messages.tick(); await service.tick();
  const first = await service.sendFrom("demo-review", thread.id, "Need clarification", undefined, "progress");
  assert.equal(first.mode, "interrupt");
  assert.deepEqual(first.target, { agentId: "demo", threadId: "source" });
  const second = await service.sendFrom("demo-review", thread.id, "Final concise result", "queue", "result");
  assert.equal(second.mode, "queue");
  assert.equal(service.decorate(fake.threads.get(thread.id)!).ask?.sentCount, 2);
  assert.equal(service.list()[0].status, "running");
  fake.finish(thread.id, "Very long private analysis that must stay in target history");
  await service.tick();
  assert.equal(service.list()[0].status, "answered");
  assert.equal(wake.list().length, 2);
  await wake.tick(); await messages.tick();
  assert.match(fake.sends[1].text, /Need clarification/);
  assert.doesNotMatch(fake.sends[1].text, /private analysis/);
});

test("bound send retry is idempotent across reload and rejects conflicting request IDs", async (t) => {
  const { create, service, wake, options } = await fixture(t);
  const { thread } = await create();
  const first = await service.sendFrom("demo-review", thread.id, "Result", undefined, "same-id");
  service.close();
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  const again = await restored.sendFrom("demo-review", thread.id, "Result", undefined, "same-id");
  assert.equal(first.deliveryId, again.deliveryId);
  assert.equal(wake.list().length, 1);
  await assert.rejects(restored.sendFrom("demo-review", thread.id, "Changed", undefined, "same-id"), /不同内容/);
  await assert.rejects(restored.sendFrom("demo", "source", "Wrong default target"), /没有绑定来源/);
});

test("late send is allowed after a no-message completion and failures still notify after progress", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create(); await messages.tick(); await service.tick(); fake.finish(thread.id);
  await service.tick(); assert.equal(service.list()[0].status, "completed");
  await service.sendFrom("demo-review", thread.id, "Late result");
  assert.equal(service.list()[0].status, "answered");
  const other = await create(); await messages.tick(); await service.tick();
  await service.sendFrom("demo-review", other.thread.id, "Progress before failure");
  fake.finish(other.thread.id, "Secret partial transcript", "failed");
  await service.tick();
  assert.equal(service.list()[1].status, "failed");
  // 完成（无通知）→ 迟到的 send → 进度 send → 失败通知：共 3 条投递。
  assert.equal(wake.list().length, 3);
  const failure = wake.list().find((entry) => /询问失败/.test(entry.preview));
  assert.ok(failure);
  assert.doesNotMatch(failure.preview, /Secret partial transcript/);
});


test("completion events work without history and follow-up turns are tracked", async (t) => {
  const { create, fake, service, messages, wake } = await fixture(t);
  const { thread } = await create(); await messages.tick(); await service.tick();
  const emit = (method: string, id: string, status: string) => fake.emit("event", {
    type: "agent.event", data: { agentId: "demo-review", method, params: { threadId: thread.id, turn: { id, status } } },
  });
  emit("turn/completed", fake.threads.get(thread.id)!.activeTurnId!, "completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal(service.list()[0].status, "completed");
  assert.equal(fake.turns.has(thread.id), false);
  assert.equal(wake.list().length, 0);
  emit("turn/started", "follow-up", "inProgress");
  assert.equal(service.list()[0].status, "running");
  await service.sendFrom("demo-review", thread.id, "Follow-up result");
  emit("turn/completed", "follow-up", "completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal(service.list()[0].status, "answered");
  assert.equal(wake.list().length, 1);
  emit("turn/started", "third-turn", "inProgress");
  emit("turn/completed", "third-turn", "failed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.equal(wake.list().length, 2);
});


test("a persisted message awaiting outbox acceptance is recovered after restart", async (t) => {
  const { create, service, wake, options } = await fixture(t);
  const { thread } = await create();
  const enqueue = wake.enqueue.bind(wake);
  wake.enqueue = async () => { throw new Error("Demo transient write failure"); };
  await assert.rejects(service.sendFrom("demo-review", thread.id, "Durable result", undefined, "durable"), /transient/);
  service.close(); wake.enqueue = enqueue;
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  await restored.tick();
  const retry = await restored.sendFrom("demo-review", thread.id, "Durable result", undefined, "durable");
  assert.ok(retry.deliveryId); assert.equal(wake.list().length, 1);
  assert.equal(restored.list()[0].sentCount, 1);
});


test("synchronous creation rejection is returned once and remains silent after reload", async (t) => {
  const { create, fake, service, wake, options } = await fixture(t);
  fake.createThread = async () => { throw new Error("Demo synchronous startup failure"); };
  await assert.rejects(create(), /Demo synchronous startup failure/);
  assert.equal(service.list()[0].status, "failed");
  await service.tick();
  assert.equal(wake.list().length, 0);
  service.close();
  const restored = new AskService(options);
  t.after(() => restored.close());
  await restored.load(); await restored.tick();
  assert.equal(wake.list().length, 0);
});
