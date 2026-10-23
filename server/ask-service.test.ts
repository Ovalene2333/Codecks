import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AskService, sanitizeInline } from "./ask-service.js";
import { DeckRecipientError } from "./deck-recipients.js";
import { MessageDeliveryQueue } from "./message-delivery.js";
import type { AgentRegistry } from "./agents/registry.js";
import type { ThreadSummary } from "./types.js";

const askReplies = (messages: MessageDeliveryQueue) =>
  messages.list().filter((entry) => entry.text?.startsWith("[ask:"));

class Agents extends EventEmitter {
  threads = new Map<string, ThreadSummary>();
  turns = new Map<string, any[]>();
  sends: { id: string; text: string; mode: string }[] = [];
  interrupts: string[] = [];
  forceStops: string[] = [];
  deleted: string[] = [];
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
  async interrupt(_agent: string, id: string, _turnId: string) {
    this.interrupts.push(id);
    if (this.threads.has(id)) this.finish(id, "", "interrupted");
  }
  async forceStop(_agent: string, id: string) {
    this.forceStops.push(id);
    if (this.threads.has(id)) this.finish(id, "", "interrupted");
  }
  async deleteThread(_agent: string, id: string) {
    this.deleted.push(id);
    this.threads.delete(id);
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
  const options = { file: path.join(dir, "asks.json"), agents, messages, timer: false as const };
  const service = new AskService(options); await service.load();
  t.after(async () => { service.close(); messages.close(); await rm(dir, { recursive: true, force: true }); });
  // 链式来源：第二个参数起依次是来源 agent、来源 thread，便于构造子会话链。
  const create = (returnMode: "queue" | "steer" | "interrupt" = "queue", detached = false, sourceAgentId = "demo", sourceThreadId = "source") => service.create({
    sourceAgentId, sourceThreadId, targetAgentId: "demo-review",
    question: 'Review "demo"\nwith context', returnMode, detached,
    settings: { cwd: "/work/demo", providerId: "acme" },
  });
  return { fake, service, messages, create, options };
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
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  assert.equal(service.list()[0].status, "running");
  fake.finish(thread.id);
  await service.tick(); await messages.tick();
  assert.equal(service.list()[0].status, "completed");
  // 纯双向通信：只有最初的问题送达，完成本身不产生任何通知。
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.interrupts.length, 0);
  assert.equal(askReplies(messages).length, 0);
  assert.doesNotMatch(fake.sends[0].text, /demo answer/);
});

test("interrupt return stops even a steer-capable non-master source and starts a new turn", async (t) => {
  // 主会话不接受 steer/interrupt 注入；注入语义只对非主节点来源（子会话链）生效。
  const { create, fake, service, messages } = await fixture(t);
  const first = await create();
  await messages.tick(); await service.tick();
  const { thread } = await create("interrupt", false, "demo-review", first.thread.id);
  await messages.tick(); await service.tick();
  await service.sendFrom("demo-review", thread.id, "Interrupting update");
  await messages.tick();
  assert.equal(fake.interrupts.length, 1);
  assert.equal(fake.sends[2].mode, "start");
  assert.match(fake.sends[2].text, /Interrupting update/);
});

test("steer return appends to the running non-master source turn without interrupting", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const first = await create();
  await messages.tick(); await service.tick();
  const { thread } = await create("steer", false, "demo-review", first.thread.id);
  await messages.tick(); await service.tick();
  await service.sendFrom("demo-review", thread.id, "Steered update");
  await messages.tick();
  assert.deepEqual(fake.interrupts, []);
  assert.equal(fake.sends[2].mode, "append");
  assert.match(fake.sends[2].text, /Steered update/);
});

test("steer override is rejected when the source cannot steer", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  const original = fake.messageState.bind(fake);
  fake.messageState = (_agentId: string, id: string) => {
    const state = original(_agentId, id);
    return { ...state, capabilities: { interrupt: false, messages: { busyBehavior: "reject", interruptScope: "session", deliveryModes: ["queue"] } } };
  };
  try {
    await assert.rejects(service.sendFrom("demo-review", thread.id, "X", "steer"), /不支持即时追加/);
  } finally {
    fake.messageState = original;
  }
});

test("restart recovers completed target history without asking or replying twice", async (t) => {
  const { create, fake, service, messages, options } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick(); service.close();
  fake.finish(thread.id);
  const restored = new AskService(options); await restored.load();
  await restored.tick(); await restored.tick();
  assert.equal(askReplies(messages).length, 0);
  assert.equal(messages.list().length, 1);
  assert.equal(restored.list()[0].status, "completed");
  restored.close();
});

test("failed target turn returns a failure message to a non-master source", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const first = await create();
  await messages.tick(); await service.tick();
  const { thread } = await create("queue", false, "demo-review", first.thread.id);
  await messages.tick(); await service.tick(); fake.finish(thread.id, "", "failed");
  await service.tick(); fake.finish(first.thread.id); await messages.tick();
  assert.equal(service.list()[1].status, "failed");
  assert.match(fake.sends[2].text, /询问失败/);
});

test("replies to an idle master source deliver without waiting for user input", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  fake.threads.get("source")!.status = "idle";
  await service.sendFrom("demo-review", thread.id, "Idle reply", "interrupt");
  await messages.tick();
  // 主会话不接受注入，但空闲时应正常送达：interrupt 降级为 queue，不打断。
  assert.deepEqual(fake.interrupts, []);
  assert.equal(fake.sends.length, 2);
  assert.equal(fake.sends[1].mode, "start");
  assert.match(fake.sends[1].text, /Idle reply/);
  assert.equal(messages.list().filter((entry) => entry.buffered === true).length, 0);
  assert.equal(messages.inbox("demo", "source").length, 0);
});

test("replies to a busy master source wait for idle instead of injecting", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  await service.sendFrom("demo-review", thread.id, "Busy reply", "interrupt");
  await messages.tick();
  // 来源正在跑：不打断、不注入，排队等空闲。
  assert.deepEqual(fake.interrupts, []);
  assert.equal(fake.sends.length, 1);
  assert.equal(messages.list().filter((entry) => entry.buffered === true).length, 0);
  fake.finish("source");
  await messages.tick();
  assert.equal(fake.sends.length, 2);
  assert.equal(fake.sends[1].mode, "start");
  assert.match(fake.sends[1].text, /Busy reply/);
});

test("cancelled question is marked cancelled without a junk reply", async (t) => {
  const { create, service, messages } = await fixture(t);
  const { item, thread } = await create();
  await messages.cancel(item.deliveryId!, "demo-review", thread.id);
  await service.tick();
  assert.equal(service.list()[0].status, "cancelled");
  assert.equal(askReplies(messages).length, 0, "中止不再向来源自动回传失败消息");
});

test("stop cancels a queued ask and stays silent toward the source", async (t) => {
  const { create, service, messages } = await fixture(t);
  const { item } = await create();
  const stopped = await service.stop(item.id, { mode: "now" });
  assert.equal(stopped.item.status, "cancelled");
  assert.equal(messages.list().some((entry) => entry.id === item.deliveryId), false);
  await service.tick(); await messages.tick();
  assert.equal(service.list()[0].status, "cancelled");
  assert.equal(askReplies(messages).length, 0);
  assert.equal((await service.stop(item.id)).alreadyStopped, true, "重复停止是幂等的");
});

test("stop interrupts a running ask without reporting a failure", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { item, thread } = await create();
  await messages.tick(); await service.tick();
  assert.equal(service.list()[0].status, "running");
  await service.stop(item.alias!, { mode: "now" });
  assert.deepEqual(fake.interrupts, [thread.id]);
  assert.equal(service.list()[0].status, "cancelled");
  await service.tick(); await messages.tick();
  assert.equal(askReplies(messages).length, 0);
});

test("stop --after-turn lets the current turn finish, then cancels silently", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { item, thread } = await create();
  await messages.tick(); await service.tick();
  const stopped = await service.stop(item.id, { mode: "after-turn" });
  assert.equal(stopped.pendingAfterTurn, true);
  assert.equal(service.list()[0].status, "running");
  assert.deepEqual(fake.interrupts, []);
  fake.finish(thread.id);
  await service.tick(); await messages.tick();
  assert.equal(service.list()[0].status, "cancelled");
  assert.equal(askReplies(messages).length, 0);
});

test("a turn interrupted outside stop becomes cancelled, not a failure reply", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  fake.finish(thread.id, "partial output", "interrupted");
  await service.tick(); await messages.tick();
  assert.equal(service.list()[0].status, "cancelled");
  assert.equal(askReplies(messages).length, 0);
});

test("deleted ask becomes a tombstone and result/inspect reject it", async (t) => {
  const { create, service } = await fixture(t);
  const { item } = await create();
  const deleted = await service.markDeleted(item.alias!);
  assert.equal(deleted.item.deletedAt !== undefined, true);
  assert.equal((service as any).items[0].question, "", "删除时清掉正文，只保留墓碑");
  await assert.rejects(service.readResult(item.alias!), (error: any) => {
    assert.ok(error instanceof DeckRecipientError);
    assert.equal(error.code, "DELETED");
    assert.equal(error.statusCode, 410);
    return true;
  });
  assert.equal((await service.markDeleted(item.alias!)).alreadyDeleted, true);
});

test("completion forwards neither final answer nor commentary", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick(); fake.finish(thread.id);
  fake.turns.get(thread.id)![0].items = [
    { type: "agentMessage", phase: "commentary", text: "intermediate-only" },
    { type: "agentMessage", phase: "final_answer", text: "final conclusion" },
  ];
  await service.tick(); await messages.tick();
  // 没有隐式转发路径：完成后的会话内容（包括最终回答）不会到达来源。
  assert.equal(fake.sends.length, 1);
  assert.equal(askReplies(messages).length, 0);
});


test("launch failure without a transcript returns its error even after backend goes offline", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  const turnId = fake.threads.get(thread.id)!.activeTurnId;
  fake.online = false;
  fake.emit("event", { type: "agent.event", data: { agentId: "demo-review", method: "turn/completed",
    params: { threadId: thread.id, turn: { id: turnId, status: "failed", error: { message: "Demo native executable not found" } } } } });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(askReplies(messages)[0].text!, /Demo native executable not found/);
  assert.equal(fake.turns.has(thread.id), false);
  await service.tick(); assert.equal(askReplies(messages).length, 1);
});

test("error summary without a persisted turn is terminal, even when not ready", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create();
  await messages.tick(); await service.tick();
  Object.assign(fake.threads.get(thread.id)!, { status: "error", activeTurnId: undefined, lastError: "Demo launcher failed" });
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(askReplies(messages)[0].text!, /Demo launcher failed/);
});

test("disabling the target records failure without waking the source", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  await create(); await messages.tick(); await service.tick();
  fake.enabled = false; fake.online = false;
  await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.match(service.list()[0].error!, /已停用/);
  assert.equal(askReplies(messages).length, 0);
  await service.tick();
  assert.equal(askReplies(messages).length, 0);
});


test("bound send supports multiple messages and completion never dumps final text", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const first = await create();
  await messages.tick(); await service.tick();
  const { thread } = await create("interrupt", false, "demo-review", first.thread.id);
  await messages.tick(); await service.tick();
  const firstSend = await service.sendFrom("demo-review", thread.id, "Need clarification", undefined, "progress");
  assert.equal(firstSend.mode, "interrupt");
  assert.deepEqual(firstSend.target, { agentId: "demo-review", threadId: first.thread.id });
  const second = await service.sendFrom("demo-review", thread.id, "Final concise result", "queue", "result");
  assert.equal(second.mode, "queue");
  assert.equal(service.decorate(fake.threads.get(thread.id)!).ask?.sentCount, 2);
  assert.equal(service.list()[1].status, "running");
  fake.finish(thread.id, "Very long private analysis that must stay in target history");
  await service.tick();
  assert.equal(service.list()[1].status, "answered");
  fake.finish(first.thread.id);
  await messages.tick(); await messages.tick();
  assert.match(fake.sends[2].text, /Need clarification/);
  assert.doesNotMatch(fake.sends[2].text, /private analysis/);
  // queue 投递在目标空闲时才发送：第一条已让目标进入新回合，需再次结束才轮到第二条。
  fake.finish(first.thread.id);
  await messages.tick();
  assert.match(fake.sends[3].text, /Final concise result/);
  assert.doesNotMatch(fake.sends[3].text, /private analysis/);
});

test("bound send retry is idempotent across reload and rejects conflicting request IDs", async (t) => {
  const { create, service, messages, options } = await fixture(t);
  const { thread } = await create();
  const first = await service.sendFrom("demo-review", thread.id, "Result", undefined, "same-id");
  service.close();
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  const again = await restored.sendFrom("demo-review", thread.id, "Result", undefined, "same-id");
  assert.equal(first.deliveryId, again.deliveryId);
  assert.equal(askReplies(messages).length, 1);
  await assert.rejects(restored.sendFrom("demo-review", thread.id, "Changed", undefined, "same-id"), /不同内容/);
  await assert.rejects(restored.sendFrom("demo", "source", "Wrong default target"), /没有绑定来源/);
});

test("late send is allowed after a no-message completion and failures still notify after progress", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
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
  const replies = askReplies(messages);
  assert.equal(replies.length, 3);
  const failure = replies.find((entry) => /询问失败/.test(entry.text || ""));
  assert.ok(failure);
  assert.doesNotMatch(failure.text!, /Secret partial transcript/);
});


test("completion events work without history and follow-up turns are tracked", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread } = await create(); await messages.tick(); await service.tick();
  const emit = (method: string, id: string, status: string) => fake.emit("event", {
    type: "agent.event", data: { agentId: "demo-review", method, params: { threadId: thread.id, turn: { id, status } } },
  });
  emit("turn/completed", fake.threads.get(thread.id)!.activeTurnId!, "completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal(service.list()[0].status, "completed");
  assert.equal(fake.turns.has(thread.id), false);
  assert.equal(askReplies(messages).length, 0);
  emit("turn/started", "follow-up", "inProgress");
  assert.equal(service.list()[0].status, "running");
  await service.sendFrom("demo-review", thread.id, "Follow-up result");
  emit("turn/completed", "follow-up", "completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal(service.list()[0].status, "answered");
  assert.equal(askReplies(messages).length, 1);
  emit("turn/started", "third-turn", "inProgress");
  emit("turn/completed", "third-turn", "failed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal(service.list()[0].status, "failed");
  assert.equal(askReplies(messages).length, 2);
});


test("a persisted message awaiting queue acceptance is recovered after restart", async (t) => {
  const { create, service, messages, options } = await fixture(t);
  const { thread } = await create();
  const enqueue = messages.enqueue.bind(messages);
  messages.enqueue = async () => { throw new Error("Demo transient write failure"); };
  await assert.rejects(service.sendFrom("demo-review", thread.id, "Durable result", undefined, "durable"), /transient/);
  service.close(); messages.enqueue = enqueue;
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  await restored.tick();
  const retry = await restored.sendFrom("demo-review", thread.id, "Durable result", undefined, "durable");
  assert.ok(retry.deliveryId); assert.equal(askReplies(messages).length, 1);
  assert.equal(restored.list()[0].sentCount, 1);
});


test("synchronous creation rejection is returned once and remains silent after reload", async (t) => {
  const { create, fake, service, messages, options } = await fixture(t);
  fake.createThread = async () => { throw new Error("Demo synchronous startup failure"); };
  await assert.rejects(create(), /Demo synchronous startup failure/);
  assert.equal(service.list()[0].status, "failed");
  await service.tick();
  assert.equal(askReplies(messages).length, 0);
  service.close();
  const restored = new AskService(options);
  t.after(() => restored.close());
  await restored.load(); await restored.tick();
  assert.equal(askReplies(messages).length, 0);
});

test("ask alias is derived once, persisted across reload and collision-safe", async (t) => {
  const { create, service, options } = await fixture(t);
  const first = await create();
  const alias = first.item.alias!;
  assert.match(alias, /^[a-z0-9]{8,32}$/);
  assert.equal(service.findByAlias(alias)?.target.threadId, first.thread.id);
  service.close();

  // 模拟旧台账：删掉别名，并加入一个前 8 位相同、同样缺别名的记录。
  const raw = JSON.parse(await readFile(options.file, "utf8"));
  const original = raw.items[0];
  original.id = randomUUID();
  const base = String(original.id).replace(/-/g, "").slice(0, 8);
  delete original.alias;
  // 换成同样前 8 位、但后续十六进制继续不同的 id，避免 8 位基名被整段包含。
  const colliding = { ...original, id: `${base}-0000-4000-8000-000000000001`, alias: undefined };
  raw.items = [original, colliding];
  await writeFile(options.file, JSON.stringify(raw));

  const restored = new AskService(options); await restored.load();
  const aliases = restored.list().map((item) => item.alias);
  assert.equal(aliases[0], base);
  // 前 8 位撞车时按基名逐步加长，不能退化成随机后缀。
  assert.match(aliases[1]!, /^[a-z0-9]{10,32}$/);
  assert.ok(aliases[1]!.startsWith(base));
  assert.ok(aliases[1]!.slice(0, 9).includes("-") === false);
  restored.close();

  const reloaded = new AskService(options); await reloaded.load();
  t.after(() => reloaded.close());
  assert.deepEqual(reloaded.list().map((item) => item.alias), aliases);
});

test("ask messages use the stable alias and never the wake lane or full ids", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const first = await create();
  await messages.tick(); await service.tick();
  const { item, thread } = await create("queue", false, "demo-review", first.thread.id);
  await messages.tick(); await service.tick();
  assert.match(fake.sends[1].text, new RegExp(`^\\[deck-api:create:${item.alias}\\]`));
  assert.doesNotMatch(fake.sends[1].text, new RegExp(item.id));
  assert.doesNotMatch(fake.sends[1].text, /\[wake:/);

  await service.sendFrom("demo-review", thread.id, "Concise result");
  fake.finish(first.thread.id);
  await messages.tick();
  assert.match(fake.sends[2].text, new RegExp(`^\\[ask:${item.alias}\\]`));
  assert.doesNotMatch(fake.sends[2].text, new RegExp(item.id));
  assert.doesNotMatch(fake.sends[2].text, new RegExp(thread.id));
  assert.doesNotMatch(fake.sends[2].text, /\[wake:|\[message:/);
  assert.equal((item as any).wakeCode, undefined);
});

test("detached saves only the final answer and can be read repeatedly after offline reload", async (t) => {
  const { create, fake, service, messages, options } = await fixture(t);
  const { thread, item } = await create("interrupt", true);
  assert.equal(thread.ask?.detached, true);
  await messages.tick(); await service.tick();
  assert.match(fake.sends[0].text, /detached 任务/);
  assert.doesNotMatch(fake.sends[0].text, /结束前必须 send/);
  assert.equal((await service.readResult(item.alias!)).result, null);
  fake.finish(thread.id);
  fake.turns.get(thread.id)![0].items = [
    { type: "reasoning", text: "private reasoning" },
    { type: "agentMessage", phase: "commentary", text: "private commentary" },
    { type: "agentMessage", phase: "final_answer", text: "Delivered: src/demo.ts; checks passed" },
  ];
  await service.tick(); await service.tick(); await messages.tick();
  const result = await service.readResult(`@${item.alias}`);
  assert.equal(result.item.status, "completed");
  assert.equal(result.item.resultAvailable, true);
  assert.equal(result.result?.text, "Delivered: src/demo.ts; checks passed");
  assert.equal(result.pending, false);
  assert.equal((service.list()[0] as any).result, undefined);
  assert.equal(askReplies(messages).length, 0);
  assert.deepEqual(fake.interrupts, []);
  service.close(); fake.online = false; fake.turns.clear();
  fake.readThread = async () => { throw new Error("Demo offline"); };
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  assert.deepEqual((await restored.readResult(item.id)).result, result.result);
  assert.deepEqual((await restored.readResult(item.alias!)).result, result.result);
  await restored.tick(); assert.equal(askReplies(messages).length, 0);
});

test("detached failures, cancellation and delivery errors stay silent across reload", async (t) => {
  const { create, fake, service, messages, options } = await fixture(t);
  for (const status of ["interrupted", "cancelled"]) {
    const { thread, item } = await create("interrupt", true);
    await messages.tick(); await service.tick(); fake.finish(thread.id, "Partial output", status);
    await service.tick();
    const read = await service.readResult(item.alias!);
    assert.equal(read.item.status, "cancelled", "中止不是失败");
    assert.equal(read.result, null); assert.equal(read.pending, false);
  }
  const failed = await create("interrupt", true);
  await messages.tick(); await service.tick(); fake.finish(failed.thread.id, "Partial output", "failed");
  await service.tick();
  const failedRead = await service.readResult(failed.item.alias!);
  assert.equal(failedRead.item.status, "failed"); assert.ok(failedRead.item.error);
  const cancelled = await create("queue", true);
  await messages.cancel(cancelled.item.deliveryId!, "demo-review", cancelled.thread.id);
  await service.tick(); assert.equal((await service.readResult(cancelled.item.id)).item.status, "cancelled");
  const broken = await create("queue", true);
  fake.sendMessage = async () => { throw new Error("Demo delivery rejected"); };
  await messages.tick();
  await service.tick(); assert.equal((await service.readResult(broken.item.id)).item.status, "failed");
  service.close();
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  await restored.tick(); await messages.tick();
  assert.equal(askReplies(messages).length, 0); assert.deepEqual(fake.interrupts, []);
});

test("detached completion events retry missing history and never return a stale follow-up result", async (t) => {
  const { create, fake, service, messages, options } = await fixture(t);
  const { thread, item } = await create("queue", true);
  await messages.tick(); await service.tick();
  const firstTurn = fake.threads.get(thread.id)!.activeTurnId;
  const emit = (method: string, id: string, status: string) => fake.emit("event", {
    type: "agent.event", data: { agentId: "demo-review", method, params: { threadId: thread.id, turn: { id, status } } },
  });
  emit("turn/completed", firstTurn!, "completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  assert.equal((await service.readResult(item.id)).pending, true);
  service.close();
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  fake.finish(thread.id, "First result");
  await restored.tick(); assert.equal((await restored.readResult(item.id)).result?.text, "First result");
  emit("turn/started", "follow-up", "inProgress");
  assert.equal((await restored.readResult(item.id)).result, null);
  assert.equal((await restored.readResult(item.id)).item.status, "running");
  await restored.sendFrom("demo-review", thread.id, "Explicit clarification", "queue");
  assert.equal(askReplies(messages).length, 1);
  fake.turns.set(thread.id, [{ id: "follow-up", status: "completed", items: [{ type: "agentMessage", text: "Follow-up result" }] }]);
  emit("turn/completed", "follow-up", "completed");
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await restored.tick();
  assert.equal((await restored.readResult(item.id)).result?.text, "Follow-up result");
  assert.equal(askReplies(messages).length, 1);
});

test("detached inspect reads live output without exposing reasoning or waking the source", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread, item } = await create("queue", true);
  await messages.tick(); await service.tick();
  fake.turns.set(thread.id, [{ id: "live", status: "inProgress", items: [
    { type: "reasoning", text: "Hidden reasoning" },
    { type: "agentMessage", text: "Working" },
    { type: "commandExecution", command: "demo check", aggregatedOutput: "check A\ncheck B" },
  ] }]);
  const view = await service.inspect(item.alias!, 3);
  assert.equal(view.output, "$ demo check\ncheck A\ncheck B");
  assert.equal(view.truncated, true);
  assert.equal((await service.readResult(item.id)).item.status, "running");
  assert.equal(askReplies(messages).length, 0);
  await assert.rejects(service.inspect(item.id, 0), /tail/);
  await assert.rejects(service.inspect("missing-alias"), /不存在/);
});

test("unavailable detached history does not block recovery of an explicitly sent message", async (t) => {
  const { create, fake, service, messages, options } = await fixture(t);
  const { thread } = await create("queue", true);
  await messages.tick(); await service.tick();
  fake.emit("event", { type: "agent.event", data: { agentId: "demo-review", method: "turn/completed",
    params: { threadId: thread.id, turn: { id: fake.threads.get(thread.id)!.activeTurnId, status: "completed" } } } });
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); await service.tick();
  const enqueue = messages.enqueue.bind(messages);
  messages.enqueue = async () => { throw new Error("Demo temporary queue failure"); };
  await assert.rejects(service.sendFrom("demo-review", thread.id, "Explicit question", "queue", "question"), /queue failure/);
  service.close(); messages.enqueue = enqueue;
  fake.readThread = async () => { throw new Error("Demo native history unavailable"); };
  const restored = new AskService(options); await restored.load(); t.after(() => restored.close());
  await restored.tick();
  assert.equal(askReplies(messages).length, 1);
  assert.match(askReplies(messages)[0].text!, /Explicit question/);
});

test("detached results explicitly report truncation and do not treat commentary as a final answer", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const first = await create("queue", true);
  await messages.tick(); await service.tick(); fake.finish(first.thread.id, "x".repeat(80_010));
  await service.tick();
  const long = (await service.readResult(first.item.id)).result!;
  assert.equal(long.text.length, 80_000); assert.equal(long.truncated, true);
  const second = await create("queue", true);
  await messages.tick(); await service.tick(); fake.finish(second.thread.id);
  fake.turns.get(second.thread.id)![0].items = [{ type: "agentMessage", phase: "commentary", text: "Still investigating" }];
  await service.tick();
  assert.equal((await service.readResult(second.item.id)).result?.text, "");
  assert.equal(askReplies(messages).length, 0);
});

test("legacy asks without targetAlias borrow the session ledger instead of the mutable thread alias", async (t) => {
  const { create, service, options } = await fixture(t);
  const { item, thread } = await create();
  const alias = "s-abc1234";
  const sessionAliases = {
    ensure: async () => new Map([[JSON.stringify(["demo-review", thread.id]), alias]]),
    peek: () => alias,
  };
  await service.close();
  // 模拟升级前的台账：只有询问别名与目标会话，没有 targetAlias。
  const file = path.join(path.dirname(options.file), "legacy-asks.json");
  await writeFile(file, JSON.stringify({ version: 1, items: [{ ...item, alias: undefined, targetAlias: undefined, question: "legacy question" }] }));
  const restored = new AskService({ ...options, file, sessionAliases });
  await restored.load();
  t.after(() => restored.close());
  assert.equal(restored.list()[0]?.targetAlias, alias);
});

test("sendFrom with one target bound to two sources reports AMBIGUOUS candidates", async (t) => {
  const { create, fake, service } = await fixture(t);
  fake.threads.set("other", { id: "other", agentId: "demo", providerId: "acme", cwd: "/work/demo", status: "idle", updatedAt: Date.now() });
  const first = await create();
  const second = await create("queue", false, "demo", "other");
  // 模拟 fork/重试：同一目标挂第二条来源不同的询问。
  (service as any).items.find((entry: any) => entry.id === second.item.id).targetThreadId = first.thread.id;
  await assert.rejects(service.sendFrom("demo-review", first.thread.id, "Hi"), (error: any) => {
    assert.ok(error instanceof DeckRecipientError);
    assert.equal(error.code, "AMBIGUOUS");
    assert.equal(error.statusCode, 409);
    assert.equal(error.candidates.length, 2);
    for (const candidate of error.candidates)
      assert.deepEqual(Object.keys(candidate).sort(), ["agentId", "alias", "status", "threadId"]);
    return true;
  });
});

test("same-source follow-ups on one target stay unambiguous", async (t) => {
  const { create, service, messages } = await fixture(t);
  const first = await create();
  const second = await create();
  // 同一来源在同一目标上追问：不算歧义，投递到第一条。
  (service as any).items.find((entry: any) => entry.id === second.item.id).targetThreadId = first.thread.id;
  const ok = await service.sendFrom("demo-review", first.thread.id, "Same source");
  assert.equal(ok.askId, first.item.id);
  assert.equal(messages.list().filter((entry) => entry.text?.includes("Same source")).length, 1);
});

test("detached capture failure is recorded instead of mistaken for task failure", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread, item } = await create("queue", true);
  await messages.tick(); await service.tick();
  const turnId = fake.threads.get(thread.id)!.activeTurnId!;
  fake.readThread = async () => { throw new Error("Demo history unavailable"); };
  fake.emit("event", { type: "agent.event", data: { agentId: "demo-review", method: "turn/completed",
    params: { threadId: thread.id, turn: { id: turnId, status: "completed" } } } });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await service.tick();
  const listed = service.list()[0] as any;
  assert.equal(listed.status, "completed");
  assert.equal(listed.resultAvailable, false);
  assert.ok(listed.captureAttempts >= 1);
  assert.match(listed.captureError, /交付同步失败/);
  const read = await service.readResult(item.id);
  assert.equal(read.result, null);
  assert.equal(read.pending, true);
  assert.ok((service as any).items[0].captureAttempts > listed.captureAttempts);
  delete fake.readThread;
  fake.turns.set(thread.id, [{ id: turnId, status: "completed", items: [{ type: "agentMessage", text: "Late result" }] }]);
  await service.tick();
  const done = await service.readResult(item.id);
  assert.equal(done.result?.text, "Late result");
  assert.equal(done.pending, false);
  assert.equal((service.list()[0] as any).captureError, undefined);
});

test("detached result correlates by turn start when the adapter changes turn ids", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread, item } = await create("queue", true);
  await messages.tick(); await service.tick();
  const record = (service as any).items[0];
  assert.ok(Number.isFinite(record.turnStartedAt));
  // 模拟 OpenCode：结束后回合 id 从 Deck 的 UUID 换成原生 user message id，
  // 且一次询问可能因重试产生多个原生回合，最终答复在最后一个回合。
  fake.turns.set(thread.id, [
    {
      id: "msg_native_1",
      status: "completed",
      startedAt: record.turnStartedAt + 50,
      items: [{ id: "msg_native_1", type: "userMessage", content: [{ type: "text", text: 'Review "demo"\nwith context' }] }],
    },
    {
      id: "msg_native_2",
      status: "completed",
      startedAt: record.turnStartedAt + 1_000,
      items: [{ id: "msg_native_2", type: "userMessage", content: [{ type: "text", text: "retry" }] },
        { type: "agentMessage", text: "Native answer" }],
    },
  ]);
  fake.threads.get(thread.id)!.status = "idle";
  fake.threads.get(thread.id)!.activeTurnId = undefined;
  record.status = "completed";
  record.turnEndedAt = record.turnStartedAt + 2_000;
  const read = await service.readResult(item.id);
  assert.equal(read.result?.text, "Native answer", "取本轮窗口内最后一个回合");
  assert.equal(read.result?.turnId, record.turnId, "结果仍记 Deck 侧 turnId");
  assert.equal(read.pending, false);
  // 早于本轮开始的回合不能被当成答案。
  fake.turns.set(thread.id, [{ id: "msg_old", status: "completed",
    startedAt: record.turnStartedAt - 60_000, items: [{ type: "agentMessage", text: "Old answer" }] }]);
  record.result = undefined;
  record.lastReadTurnId = undefined;
  const none = await service.readResult(item.id);
  assert.equal(none.result, null);
  assert.equal(none.pending, true);
});

test("detached completion stays query-only for a master source", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread, item } = await create("queue", true);
  await messages.tick(); await service.tick();
  fake.finish(thread.id, "Done work");
  await service.tick();
  const dones = () => messages.list().filter((entry) => entry.text?.startsWith(`[done:${item.alias}]`));
  assert.equal(service.isMaster("demo", "source"), true);
  assert.equal(dones().length, 0, "主会话运行中不接收完成推送");
  const read = await service.readResult(item.id);
  assert.equal(read.result?.text, "Done work");
  await (service as any).notifyDone((service as any).items[0]);
  assert.equal(dones().length, 0, "重复完成事件也不补发通知");
});

test("failed detached stays query-only and records the error", async (t) => {
  const { create, fake, service, messages } = await fixture(t);
  const { thread, item } = await create("queue", true);
  await messages.tick(); await service.tick();
  fake.threads.get(thread.id)!.lastError = "boom\napi_key=sk-abcdef1234567890\nBearer secrettoken\nurl=https://acme.example/?token=ABC&x=1";
  fake.finish(thread.id, "", "failed");
  await service.tick();
  const dones = messages.list().filter((entry) => entry.text?.startsWith(`[done:${item.alias}]`));
  assert.equal(dones.length, 0, "主会话不接收失败推送，改用 result/tasks 查询");
  const read = await service.readResult(item.id);
  assert.equal(read.result, null);
  assert.equal(read.pending, false);
  assert.match(read.item.error ?? "", /boom/);
});

test("sanitizeInline folds lines and redacts credentials", () => {
  assert.equal(sanitizeInline("a\nb  c"), "a b c");
  assert.match(sanitizeInline("key=sk-abcdef1234567890 rest")!, /\[已脱敏\]/);
  assert.doesNotMatch(sanitizeInline("key=sk-abcdef1234567890")!, /sk-/);
  assert.match(sanitizeInline("Bearer secrettoken123")!, /Bearer \[已脱敏\]/);
  assert.match(sanitizeInline("url?api_key=ABC&x=1")!, /api_key=\[已脱敏\]/);
  assert.equal(sanitizeInline("x".repeat(200), 10), "x".repeat(10));
  assert.equal(sanitizeInline(undefined), "");
});

test("master detection follows ask targets and decorate exposes buffered count", async (t) => {
  const { create, service, messages } = await fixture(t);
  assert.equal(service.isMaster("demo", "source"), true);
  assert.equal(service.isMaster("demo-review", "ghost"), true);
  const { thread } = await create();
  assert.equal(service.isMaster("demo-review", thread.id), false);
  assert.equal(service.isMaster("demo", "source"), true);
  assert.equal(service.decorate({ id: "source", agentId: "demo" } as any).bufferedCount, undefined);
  await messages.enqueue("demo", "source", "queue", { text: "Buffered one" }, { id: "buf-1", buffered: true });
  await messages.enqueue("demo", "source", "queue", { text: "Direct one" }, { id: "dir-1" });
  assert.equal(service.decorate({ id: "source", agentId: "demo" } as any).bufferedCount, 1);
});
