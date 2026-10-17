import assert from "node:assert/strict";
import test from "node:test";
import { CodexAdapter } from "./agents/codex-adapter.js";
import { OpenCodeAdapter } from "./agents/opencode-adapter.js";
import { AgentRegistry } from "./agents/registry.js";
import { MessageDeliveryQueue } from "./message-delivery.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function codexFixture(status: "idle" | "running" | "waiting" = "running") {
  const adapter = new CodexAdapter({ get: () => ({ id: "p", kind: "local-profile" }) } as any, "/tmp") as any;
  const thread = { id: "t", providerId: "p", cwd: "/tmp", status, activeTurnId: status === "idle" ? undefined : "old-turn" };
  adapter.threads.set("t", thread);
  const calls: { method: string; params: any }[] = [];
  let failSteer = false;
  adapter.prepareThread = async () => ({
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "turn/steer" && failSteer) throw new Error("no active turn");
      return method === "turn/steer" ? { turnId: "old-turn" } : { turn: { id: "new-turn" } };
    },
  });
  return { adapter, thread, calls, failSteer: () => { failSteer = true; } };
}

test("Codex strict append targets the expected turn in running and approval-waiting states", async () => {
  for (const state of ["running", "waiting"] as const) {
    const fixture = codexFixture(state);
    const receipt = await fixture.adapter.sendMessage("p", "t", { text: "more", mode: "append", expectedTurnId: "old-turn" });
    assert.deepEqual(receipt, { disposition: "appended", turnId: "old-turn" });
    assert.equal(fixture.calls[0].method, "turn/steer");
    assert.equal(fixture.calls[0].params.expectedTurnId, "old-turn");
  }
});

test("Codex strict append never starts a new turn after the target finishes", async () => {
  const fixture = codexFixture();
  fixture.failSteer();
  await assert.rejects(fixture.adapter.sendMessage("p", "t", { text: "more", mode: "append", expectedTurnId: "old-turn" }), { code: "no_active_turn" });
  assert.deepEqual(fixture.calls.map((call) => call.method), ["turn/steer"]);
  const receipt = await fixture.adapter.sendMessage("p", "t", { text: "more", mode: "auto" });
  assert.equal(receipt.disposition, "started");
  assert.equal(receipt.turnId, "new-turn");
  assert.deepEqual(fixture.calls.map((call) => call.method), ["turn/steer", "turn/steer", "turn/start"]);
});

test("Codex rechecks start after asynchronous session preparation", async () => {
  const fixture = codexFixture("idle");
  const prepare = fixture.adapter.prepareThread;
  fixture.adapter.prepareThread = async () => {
    fixture.thread.status = "running";
    fixture.thread.activeTurnId = "new-owner";
    return prepare();
  };
  await assert.rejects(fixture.adapter.sendMessage("p", "t", { text: "hello", mode: "start" }), { code: "busy" });
  assert.equal(fixture.calls.length, 0);
});

test("Codex strict append uses the active id even if its status snapshot is temporarily idle", async () => {
  const fixture = codexFixture("running");
  fixture.thread.status = "idle";
  const receipt = await fixture.adapter.sendMessage("p", "t", { text: "more", mode: "append", expectedTurnId: "old-turn" });
  assert.equal(receipt.disposition, "appended");
  assert.equal(fixture.calls[0].method, "turn/steer");
});

test("OpenCode busy acceptance is not reported as a guaranteed append", async () => {
  const calls: string[] = [];
  const adapter = new OpenCodeAdapter({
    initialThreads: [{ id: "t", agentId: "opencode", providerId: "p", name: "test", preview: "", cwd: "/tmp", model: "default", status: "running", activeTurnId: "old-turn", updatedAt: 1 }],
    fetcher: (async (url) => { calls.push(String(url)); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  const receipt = await adapter.sendMessage("p", "t", { text: "more" });
  assert.equal(receipt.disposition, "backend-managed");
  assert.equal(new URL(calls[0]).pathname, "/session/t/prompt_async");
  await assert.rejects(adapter.sendMessage("p", "t", { text: "more", mode: "append", expectedTurnId: receipt.turnId }), { code: "unsupported" });
  assert.equal(calls.length, 1);
  await adapter.interrupt("p", "t", receipt.turnId!);
  assert.equal(new URL(calls[1]).pathname, "/session/t/abort");
});

test("OpenCode user feedback sends abort before prompt_async", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-feedback-"));
  const calls: string[] = [];
  const adapter = new OpenCodeAdapter({
    idleGraceMs: 0,
    initialThreads: [{ id: "t", agentId: "opencode", providerId: "p", name: "test", preview: "", cwd: "/tmp", model: "default", status: "running", activeTurnId: "old-turn", updatedAt: 1 }],
    fetcher: (async (url) => {
      const pathname = new URL(String(url)).pathname;
      calls.push(pathname);
      if (pathname.endsWith("/abort")) setTimeout(() => (adapter as any).onEvent({
        type: "session.status", properties: { sessionID: "t", status: { type: "idle" } },
      }), 0);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  const descriptor = adapter.descriptor.bind(adapter);
  adapter.descriptor = () => ({ ...descriptor(), online: true });
  const deliveries = new MessageDeliveryQueue({ file: path.join(dir, "messages.json"), agents: new AgentRegistry([adapter]), timer: false });
  await deliveries.load();
  t.after(async () => { deliveries.close(); await rm(dir, { recursive: true, force: true }); });
  await deliveries.enqueue(adapter.id, "t", "feedback", { text: "new instruction" });
  await deliveries.tick();
  assert.deepEqual(calls, ["/session/t/abort", "/session/t/prompt_async"]);
  assert.equal(deliveries.list()[0].disposition, "started");
});

test("Codex exposes both user modes: queued start and immediate steer", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-codex-modes-"));
  const fixture = codexFixture();
  fixture.adapter.descriptor = () => ({ id: "codex", name: "Codex", available: true, online: true,
    capabilities: { interrupt: true, messages: { busyBehavior: "steer", interruptScope: "turn" } } });
  fixture.adapter.snapshot = () => ({ threads: [fixture.thread], approvals: [] });
  const deliveries = new MessageDeliveryQueue({ file: path.join(dir, "messages.json"), agents: new AgentRegistry([fixture.adapter]), timer: false });
  await deliveries.load();
  t.after(async () => { deliveries.close(); await rm(dir, { recursive: true, force: true }); });
  await deliveries.enqueue("codex", "t", "queue", { text: "later" });
  await deliveries.tick();
  assert.equal(fixture.calls.length, 0);
  await deliveries.enqueue("codex", "t", "feedback", { text: "now" });
  await deliveries.tick();
  assert.equal(fixture.calls[0].method, "turn/steer");
  fixture.thread.status = "idle";
  fixture.thread.activeTurnId = undefined;
  await deliveries.tick();
  assert.equal(fixture.calls[1].method, "turn/start");
});
