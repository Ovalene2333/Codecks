import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRegistry } from "./agents/registry.js";
import { DeckInbox } from "./deck-inbox.js";
import { DeckRequests } from "./deck-requests.js";
import { MessageDeliveryQueue } from "./message-delivery.js";

const source = { agentId: "demo", threadId: "source" };
const target = { agentId: "demo", threadId: "target" };

async function fixture(context: any) {
  const directory = await mkdtemp(path.join(tmpdir(), "deck-inbox-test-"));
  let ready = false;
  let count = 0;
  const registry = Object.assign(new EventEmitter(), {
    messageBackendOnline: () => true,
    messageState: () => ({ online: true, ready, thread: { id: "target", status: ready ? "idle" : "running" },
      capabilities: { messages: { deliveryModes: ["queue", "feedback"], busyBehavior: "steer" } } }),
    sendMessage: async () => { count++; ready = false; return { disposition: "started", turnId: `turn-${count}` }; },
  }) as unknown as AgentRegistry;
  const messages = new MessageDeliveryQueue({ file: path.join(directory, "queue.json"), agents: registry, timer: false });
  await messages.load();
  const options = { file: path.join(directory, "inbox.json"), agents: registry, messages, timer: false, mergeWindowMs: 0 };
  const inbox = new DeckInbox(options);
  await inbox.load();
  context.after(async () => { inbox.close(); messages.close(); await rm(directory, { recursive: true, force: true }); });
  const send = (text: string, requestId?: string) => inbox.append({ from: source, to: target, text, requestId });
  return { inbox, messages, registry, options, directory, send, ready: (value: boolean) => { ready = value; }, count: () => count };
}

test("busy inbox accepts durably, deduplicates explicit destinations and replays receive", async (context) => {
  const { inbox, send, count, options } = await fixture(context);
  const first = await send("first", "send-one");
  assert.equal((await send("first", "send-one")).messageId, first.messageId);
  await assert.rejects(send("changed", "send-one"), { code: "REQUEST_CONFLICT" });
  await send("second");
  await inbox.tick();
  assert.equal(count(), 0);
  const received = await inbox.receive(target, "receive-one");
  assert.deepEqual(received.messages.map((entry: any) => entry.text), ["first", "second"]);
  const restored = new DeckInbox(options); await restored.load(); context.after(() => restored.close());
  assert.deepEqual((await restored.receive(target, "receive-one")).messages, received.messages);
  assert.deepEqual((await restored.receive(target, "receive-two")).messages, []);
  assert.equal((restored.replay(target) as any).batches.length, 2);
  await assert.rejects(restored.receive(target, "receive-one", 1), { code: "REQUEST_CONFLICT" });
});

test("idle dispatch batches messages, owned queue items cannot become user drafts", async (context) => {
  const { inbox, messages, send, ready, count } = await fixture(context);
  ready(true); await send("first"); await send("second");
  await inbox.tick();
  const delivery = messages.list()[0];
  assert.equal(delivery.owner, "deck-inbox");
  await assert.rejects(messages.feedback(delivery.id, target.agentId, target.threadId), { statusCode: 403 });
  await assert.rejects(messages.cancel(delivery.id, target.agentId, target.threadId), { statusCode: 403 });
  await assert.rejects(messages.retry(delivery.id, target.agentId, target.threadId), { statusCode: 403 });
  await messages.tick(); await inbox.tick();
  assert.equal(count(), 1);
  assert.deepEqual((await inbox.receive(target, "after-auto")).messages, []);
});

test("receive takes queued batches when a user starts a turn before dispatch", async (context) => {
  const { inbox, send, ready, messages, count } = await fixture(context);
  ready(true); await send("take back"); await inbox.tick();
  ready(false);
  const received = await inbox.receive(target, "take-queued");
  assert.equal(received.messages[0].text, "take back");
  assert.equal(messages.list().length, 0);
  ready(true); await inbox.tick(); await messages.tick();
  assert.equal(count(), 0);
});

test("waiting receive wins, concurrent consumers reject, cancellation does not consume", async (context) => {
  const { inbox, send, ready, count } = await fixture(context);
  ready(true);
  const controller = new AbortController();
  const waiting = inbox.receive(target, "waiting", 2, controller.signal);
  await assert.rejects(inbox.receive(target, "other", 0), { code: "BUSY" });
  await send("question"); await inbox.tick();
  assert.equal((await waiting).messages[0].text, "question");
  assert.equal(count(), 0);
  const cancelled = inbox.receive(target, "cancelled", 2, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { code: "CANCELLED" });
  await send("still here");
  assert.equal((await inbox.receive(target, "after-cancel")).messages[0].text, "still here");
});

test("silent results persist without waking and batch limits preserve remaining messages", async (context) => {
  const { inbox, ready, count, send } = await fixture(context);
  ready(true);
  await inbox.append({ from: source, to: target, kind: "result", text: "background", wake: false });
  await inbox.tick(); assert.equal(count(), 0);
  for (let index = 0; index < 21; index++) await send(`message-${index}`);
  const first = await inbox.receive(target, "batch-one");
  assert.equal(first.messages.length, 20); assert.equal(first.hasMore, true);
  assert.equal((await inbox.receive(target, "batch-two")).messages.length, 2);
});

test("deletion ends waiters and blocks append, restart preserves lifecycle", async (context) => {
  const { inbox, options, send } = await fixture(context);
  const waiting = inbox.receive(target, "deleting", 2);
  const rejected = assert.rejects(waiting, { code: "DELETING" });
  await inbox.control(target, "deleting"); await rejected;
  await assert.rejects(send("late"), { code: "DELETING" });
  await inbox.control(target, "deleted");
  const restored = new DeckInbox(options); await restored.load(); context.after(() => restored.close());
  await assert.rejects(restored.receive(target, "gone"), { code: "DELETED" });
});

test("automatic round budget persists across restart and receive still works", async (context) => {
  const { inbox, messages, send, ready, count, options } = await fixture(context);
  for (let index = 0; index < 11; index++) {
    ready(true); await send(`work-${index}`); await inbox.tick(); await messages.tick(); await inbox.tick();
  }
  assert.equal(count(), 10);
  assert.equal(inbox.summary(target).reason, "budget");
  const restored = new DeckInbox(options); await restored.load(); context.after(() => restored.close());
  assert.equal(restored.summary(target).paused, true);
  assert.equal((await restored.receive(target, "manual")).messages.length, 1);
});

test("unknown native acceptance is never automatically resent after restart", async (context) => {
  const { inbox, messages, send, ready, options } = await fixture(context);
  ready(true); await send("uncertain"); await inbox.tick();
  const queuePath = path.join(path.dirname(options.file), "queue.json");
  const queue = JSON.parse(await readFile(queuePath, "utf8"));
  queue.items[0].status = "sending";
  await writeFile(queuePath, JSON.stringify(queue));
  messages.close();
  const restoredQueue = new MessageDeliveryQueue({ file: queuePath, agents: options.agents, timer: false });
  await restoredQueue.load(); context.after(() => restoredQueue.close());
  const restored = new DeckInbox({ ...options, messages: restoredQueue });
  await restored.load(); context.after(() => restored.close()); await restored.tick();
  assert.equal(restored.summary(target).unknown, 1);
  assert.deepEqual((await restored.receive(target, "no-duplicate")).messages, []);
  const batchId = restored.summary(target).uncertain[0].batchId;
  await restored.recover(target, batchId, false);
  assert.equal((await restored.receive(target, "confirmed-unsent")).messages[0].text, "uncertain");
});

test("malformed ledger and failed persistence never become successful consumption", async (context) => {
  const { options, send, inbox, directory } = await fixture(context);
  await send("keep");
  await writeFile(path.join(directory, "broken.json"), "not-json");
  const broken = new DeckInbox({ ...options, file: path.join(directory, "broken.json") });
  await broken.load(); context.after(() => broken.close());
  await assert.rejects(broken.receive(target, "broken"), { code: "INBOX_UNAVAILABLE" });
  assert.equal(await readFile(path.join(directory, "broken.json"), "utf8"), "not-json");
  await rm(options.file);
  const inaccessible = new DeckInbox({ ...options, file: path.join(directory, "obstruction", "inbox.json") });
  await inaccessible.load(); context.after(() => inaccessible.close());
  await writeFile(path.join(directory, "obstruction"), "x");
  await assert.rejects(inaccessible.append({ from: source, to: target, text: "not accepted" }), { code: "INBOX_PERSIST_FAILED" });
  assert.equal(inbox.summary(target).pending, 1);
});

test("create requests replay completed responses and never repeat uncertain work", async (context) => {
  const { directory } = await fixture(context);
  const file = path.join(directory, "requests.json");
  const requests = new DeckRequests(file); await requests.load();
  let created = 0;
  const create = async () => ({ target: `child-${++created}` });
  const replies = await Promise.all([requests.execute("demo", "one", { text: "task" }, create), requests.execute("demo", "one", { text: "task" }, create)]);
  assert.deepEqual(replies[0], replies[1]); assert.equal(created, 1);
  const restored = new DeckRequests(file); await restored.load();
  assert.deepEqual(await restored.execute("demo", "one", { text: "task" }, create), replies[0]);
  await assert.rejects(restored.execute("demo", "one", { text: "changed" }, create), { code: "REQUEST_CONFLICT" });
  await assert.rejects(restored.execute("demo", "failed", {}, async () => { throw new Error("uncertain"); }));
  await assert.rejects(restored.execute("demo", "failed", {}, create), { code: "REQUEST_UNCERTAIN" });
  assert.equal(created, 1);
});

test("deletion preflight releases its gate on BUSY without consuming user queue entries", async (context) => {
  const { inbox, messages, ready } = await fixture(context);
  ready(true);
  await messages.enqueue(target.agentId, target.threadId, "queue", { text: "user draft" });
  await assert.rejects(inbox.beginDelete(target, false, () => true), { code: "BUSY" });
  assert.doesNotThrow(() => inbox.assertActive(target));
  await inbox.beginDelete(target, true, () => true);
  assert.throws(() => inbox.assertActive(target), { code: "DELETING" });
  assert.equal(messages.list().length, 1);
  await inbox.control(target, "restore");
  assert.doesNotThrow(() => inbox.assertActive(target));
});

test("stop releases unsent batches without deleting messages and human continue preserves the hourly limit", async (context) => {
  const { inbox, messages, send, ready, count } = await fixture(context);
  ready(true); await send("preserve on stop"); await inbox.tick();
  assert.equal(messages.list().length, 1);
  await inbox.control(target, "pause");
  assert.equal(messages.list().length, 0);
  await inbox.tick(); await messages.tick();
  assert.equal(count(), 0);
  assert.equal((await inbox.receive(target, "after-stop")).messages[0].text, "preserve on stop");
  for (let index = 0; index < 30; index++) {
    await inbox.control(target, "human");
    ready(true); await send(`work-${index}`); await inbox.tick(); await messages.tick(); await inbox.tick();
  }
  assert.equal(count(), 30);
  await inbox.control(target, "human");
  assert.equal(inbox.summary(target).paused, true);
  ready(true); await send("hourly pending"); await inbox.tick(); await messages.tick();
  assert.equal(count(), 30);
  assert.equal((await inbox.receive(target, "over-hourly-limit")).messages[0].text, "hourly pending");
});

test("taking back queued batches never spends automatic turn budget", async (context) => {
  const { inbox, send, ready, count } = await fixture(context);
  ready(true);
  for (let index = 0; index < 11; index++) {
    await send(`take-${index}`); await inbox.tick();
    assert.equal((await inbox.receive(target, `take-${index}`)).messages.length, 1);
  }
  assert.equal(count(), 0);
  assert.equal(inbox.summary(target).paused, false);
});

test("parent human input resets child budget without resuming a stopped child", async (context) => {
  const { inbox, messages, ready, send, count } = await fixture(context);
  ready(true); await send("pending work");
  await inbox.control(target, "pause");
  await inbox.control(target, "reset-budget");
  assert.equal(inbox.summary(target).paused, true);
  assert.equal(inbox.summary(target).reason, "stopped");
  await inbox.tick(); await messages.tick();
  assert.equal(count(), 0);
  assert.equal(inbox.summary(target).pending, 1);
  await inbox.control(target, "human");
  await inbox.tick(); await messages.tick();
  assert.equal(count(), 1);
});
