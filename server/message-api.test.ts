import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { AgentRegistry } from "./agents/registry.js";
import type { AgentAdapter, AgentCapabilities } from "./agents/types.js";
import type { ThreadSummary } from "./types.js";
import type { AgentMessageCapabilities, AgentMessageInput, AgentMessageAcceptance } from "./agents/messages.js";
import { registerMessageRoutes } from "./message-api.js";
import { MessageDeliveryQueue } from "./message-delivery.js";

class MessageAgent extends EventEmitter implements AgentAdapter {
  readonly id = "test-agent";
  readonly thread: ThreadSummary = {
    id: "session:one/branch", agentId: this.id, providerId: "profile", name: "test",
    preview: "", cwd: "/tmp", model: "default", status: "idle", updatedAt: 1,
  };
  sent: AgentMessageInput[] = [];
  interrupted: string[] = [];
  hold?: () => Promise<void>;
  constructor(readonly messages: AgentMessageCapabilities) { super(); }
  descriptor() {
    const capabilities: AgentCapabilities = {
      messages: this.messages, approvals: false, archive: false, delete: false, fork: false,
      images: false, interrupt: true, mcp: false, models: false, review: false,
      sessionSettings: false, shell: false, skills: false,
    };
    return { id: this.id, name: "test", available: true, online: true, capabilities };
  }
  snapshot() { return { threads: [this.thread], approvals: [] }; }
  async startAll() {}
  async refreshAll() {}
  restart() {}
  busyThreads() { return this.thread.status === "running" ? [this.thread] : []; }
  async sendMessage(providerId: string, threadId: string, input: AgentMessageInput): Promise<AgentMessageAcceptance> {
    assert.equal(providerId, this.thread.providerId);
    assert.equal(threadId, this.thread.id);
    this.sent.push(input);
    await this.hold?.();
    const busy = this.thread.status !== "idle";
    if (busy && this.messages.busyBehavior === "queue")
      return { disposition: "queued", turnId: "queued-turn", queueDurability: "memory" };
    this.thread.status = "running";
    this.thread.activeTurnId = "active-turn";
    return { disposition: busy ? "appended" : "started", turnId: "active-turn" };
  }
  async interrupt(_providerId: string, _threadId: string, turnId: string) {
    this.interrupted.push(turnId);
    return { ok: true };
  }
}

test("message acceptance serializes competing starts and releases the lock after rejection", async () => {
  const agent = new MessageAgent({ busyBehavior: "steer", interruptScope: "turn" });
  const registry = new AgentRegistry([agent]);
  const first = registry.sendMessage(agent.id, agent.thread.id, { text: "first", mode: "start" });
  const second = registry.sendMessage(agent.id, agent.thread.id, { text: "second", mode: "start" });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(agent.sent.length, 1);
  const receipt = await registry.sendMessage(agent.id, agent.thread.id, {
    text: "append", mode: "append", expectedTurnId: "active-turn",
  });
  assert.equal(receipt.disposition, "appended");
  assert.equal(receipt.status, "accepted");
});

test("queue acknowledgement preserves memory durability and interruption preserves the active state", async () => {
  const agent = new MessageAgent({ busyBehavior: "queue", interruptScope: "session", queueDurability: "memory" });
  const registry = new AgentRegistry([agent]);
  await registry.sendMessage(agent.id, agent.thread.id, { text: "first" });
  const receipt = await registry.sendMessage(agent.id, agent.thread.id, { text: "second" });
  assert.equal(receipt.disposition, "queued");
  assert.equal(receipt.queueDurability, "memory");
  await assert.rejects(registry.interruptMessage(agent.id, agent.thread.id, "stale"), { code: "turn_mismatch" });
  assert.deepEqual(agent.interrupted, []);
  const interrupt = await registry.interruptMessage(agent.id, agent.thread.id, "active-turn");
  assert.equal(interrupt.status, "interrupt_requested");
  assert.equal(interrupt.scope, "session");
  assert.equal(agent.thread.status, "running", "请求打断不能提前宣告已停止");
});

test("message API rejects invalid policies and stale turns without invoking the backend", async (t) => {
  const agent = new MessageAgent({ busyBehavior: "reject", interruptScope: "session" });
  const registry = new AgentRegistry([agent]);
  const app = express();
  app.use(express.json());
  registerMessageRoutes(app, registry);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/agents/${agent.id}/threads/${encodeURIComponent(agent.thread.id)}/messages`;
  const post = (body: unknown, suffix = "") => fetch(url + suffix, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await post({ text: "hi", mode: "interrupt" })).status, 400);
  assert.equal((await post({ text: "hi", mode: "append" })).status, 400);
  assert.equal((await post({ text: "hi", idempotencyKey: "unsupported" })).status, 400);
  const empty = await post({ text: " " });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "invalid_request");
  assert.equal(agent.sent.length, 0);
  const accepted = await post({ text: "hello", mode: "start" });
  assert.equal(accepted.status, 200);
  const receipt = await accepted.json();
  assert.equal(receipt.disposition, "started");
  assert.equal(receipt.threadId, agent.thread.id);
  assert.ok(receipt.id);
  const busy = await post({ text: "again" });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, "busy");
  const unsupported = await post({ text: "again", mode: "append", expectedTurnId: "active-turn" });
  assert.equal(unsupported.status, 422);
  assert.equal((await unsupported.json()).code, "unsupported");
  const stale = await post({ expectedTurnId: "stale" }, "/interrupt");
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "turn_mismatch");
  assert.equal(agent.interrupted.length, 0);
});

test("archived, compacting and disabled targets reject messages", async () => {
  const agent = new MessageAgent({ busyBehavior: "steer", interruptScope: "turn" });
  const registry = new AgentRegistry([agent]);
  agent.thread.archived = true;
  await assert.rejects(registry.sendMessage(agent.id, agent.thread.id, { text: "hello" }), { code: "archived" });
  agent.thread.archived = false;
  agent.thread.compacting = true;
  await assert.rejects(registry.sendMessage(agent.id, agent.thread.id, { text: "hello" }), { code: "compacting" });
  agent.thread.compacting = false;
  registry.configure(agent.id, { enabled: false });
  await assert.rejects(registry.sendMessage(agent.id, agent.thread.id, { text: "hello" }), /未启用/);
  assert.equal(agent.sent.length, 0);
});

test("message routes promote queue bubbles in place and cancel them", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-message-api-"));
  const file = path.join(dir, "messages.json");
  const agent = new MessageAgent({ busyBehavior: "reject", interruptScope: "session" });
  agent.thread.status = "running";
  agent.thread.activeTurnId = "active-turn";
  const registry = new AgentRegistry([agent]);
  assert.deepEqual(registry.list()[0].capabilities.messages?.deliveryModes, ["queue", "feedback"]);
  const deliveries = new MessageDeliveryQueue({ file, agents: registry, timer: false });
  await deliveries.load();
  const handlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
  const app = {
    post: (path: string, handler: (req: Request, res: Response) => Promise<void>) => handlers.set(`POST ${path}`, handler),
    delete: (path: string, handler: (req: Request, res: Response) => Promise<void>) => handlers.set(`DELETE ${path}`, handler),
  } as unknown as Express;
  registerMessageRoutes(app, registry, deliveries);
  t.after(async () => {
    deliveries.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = async (method: string, suffix: string, body: unknown = {}, params: Record<string, string> = {}) => {
    const handler = handlers.get(`${method} /api/agents/:agentId/threads/:threadId/messages${suffix}`);
    assert.ok(handler, "应注册对应消息路由");
    let statusCode = 200;
    let data: any;
    const response = {
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { data = JSON.parse(JSON.stringify(value)); return this; },
    } as unknown as Response;
    await handler({ params: { agentId: agent.id, threadId: agent.thread.id, ...params }, body } as Request, response);
    return { status: statusCode, data };
  };
  const response = await request("POST", "", { text: "next", mode: "queue" });
  assert.equal(response.status, 202);
  const receipt = response.data;
  assert.equal(receipt.queueDurability, "disk");
  assert.equal(JSON.parse(await readFile(file, "utf8")).items[0].input.text, "next");
  await deliveries.tick();
  assert.equal(agent.sent.length, 0);
  const target = { messageId: receipt.id };
  const promoted = await request("POST", "/:messageId/feedback", {}, target);
  assert.equal(promoted.status, 202);
  const feedback = promoted.data;
  assert.equal(feedback.id, receipt.id);
  assert.equal(feedback.mode, "feedback");
  assert.equal(feedback.text, "next");
  assert.equal((await request("POST", "/:messageId/feedback", {}, target)).status, 202);
  assert.equal(deliveries.list().length, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).items[0].mode, "feedback");
  assert.equal((await request("POST", "/:messageId/feedback", {}, { ...target, threadId: "other-thread" })).status, 404);
  assert.equal((await request("DELETE", "/:messageId", {}, target)).status, 200);
  assert.deepEqual(deliveries.list(), []);
  assert.equal((await request("POST", "/:messageId/feedback", {}, target)).status, 404);
});
