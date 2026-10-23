import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeckNotices, noticePolicySchema } from "./deck-notices.js";
import type { MessageDeliveryQueue } from "./message-delivery.js";

const task = (id: string, overrides = {}) => ({ id, alias: id, sourceAgentId: "demo", sourceThreadId: "source", targetAgentId: "demo", turnId: "turn", createdAt: 1, returnMode: "queue" as const, status: "completed" as const, resultAvailable: true, ...overrides });

test("startup baselines historical failures but preserves pending notices and new failures", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const messages = { enqueue: async (...args: any[]) => { sent.push(args[3].text); return { status: "queued" }; } } as any;
  const file = path.join(dir, "notices.json");
  const failed = (id: string, overrides = {}) => task(id, { status: "failed", resultAvailable: false, ...overrides });
  const before = new DeckNotices(file, messages); await before.load();
  await before.tick([failed("pending")], 1000);
  const restored = new DeckNotices(file, messages); await restored.load();
  await restored.baseline([failed("historical"), failed("pending"), task("running", { status: "running", resultAvailable: false })]);
  await restored.tick([failed("historical"), failed("pending"), failed("running")], 6000);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /@pending/); assert.match(sent[0], /@running/);
  assert.doesNotMatch(sent[0], /@historical/);
  const again = new DeckNotices(file, messages); await again.load();
  await again.tick([failed("historical")], 70000);
  assert.equal(sent.length, 1);
});

test("completion defaults silent, configured digests batch and limit staggered results across restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: any[] = [];
  const messages = { enqueue: async (...args: any[]) => { calls.push(args); return { id: args[4].id }; } } as unknown as MessageDeliveryQueue;
  const file = path.join(dir, "notices.json");
  const notices = new DeckNotices(file, messages); await notices.load();
  await notices.tick([task("old")], 1000); assert.equal(calls.length, 0);
  await notices.configure("demo", "source", noticePolicySchema.parse({ resultReady: true, windowSeconds: 2, minIntervalSeconds: 10 }));
  await notices.tick([task("old"), task("a"), task("b")], 2000);
  assert.equal(calls.length, 0);
  await notices.tick([], 4000); assert.equal(calls.length, 1);
  assert.match(calls[0][3].text, /@a.*@b/); assert.doesNotMatch(calls[0][3].text, /@old/);
  await notices.tick([task("c")], 5000); await notices.tick([], 7000);
  assert.equal(calls.length, 1);
  const restored = new DeckNotices(file, messages); await restored.load();
  await restored.tick([], 14000); assert.equal(calls.length, 2);
  await restored.tick([task("a"), task("b"), task("c")], 30000);
  assert.equal(calls.length, 2);
});

test("digest enqueue failure retries identical id and body after reload", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: any[] = []; let offline = true;
  const messages = { enqueue: async (...args: any[]) => { calls.push(args); if (offline) throw new Error("offline"); return { id: args[4].id }; } } as unknown as MessageDeliveryQueue;
  const file = path.join(dir, "notices.json");
  const notices = new DeckNotices(file, messages); await notices.load();
  await notices.configure("demo", "source", noticePolicySchema.parse({ resultReady: true, windowSeconds: 0 }));
  await notices.tick([task("a")], 1000);
  const restored = new DeckNotices(file, messages); await restored.load(); offline = false;
  await restored.tick([], 4000);
  assert.deepEqual(calls[0], calls[1]);
});

test("ordinary failures retain default notification and detached failures stay silent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const messages = { enqueue: async (...args: any[]) => { sent.push(args[3].text); return { id: args[4].id }; } } as unknown as MessageDeliveryQueue;
  const notices = new DeckNotices(path.join(dir, "notices.json"), messages); await notices.load();
  await notices.tick([task("a", { status: "failed", resultAvailable: false }), task("b", { status: "failed", resultAvailable: false, detached: true })], 1000);
  await notices.tick([], 6000);
  assert.equal(sent.length, 1); assert.match(sent[0], /@a/); assert.doesNotMatch(sent[0], /@b/);
});

test("corrupt notification ledger pauses only notices and preserves the original file", async (t) => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "notices.json"); await writeFile(file, '{"invalid":true}');
  const notices = new DeckNotices(file, { enqueue: async () => { throw new Error("must not send"); } } as any);
  await notices.load(); await notices.tick([task("a")]);
  assert.ok(notices.status("demo", "source").error);
  await assert.rejects(notices.configure("demo", "source", noticePolicySchema.parse({})), /暂停/);
  assert.equal(await readFile(file, "utf8"), '{"invalid":true}');
});

test("permanent failures become observable dead notices, and reset ledgers cannot reuse digest ids", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-dead-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const queue = { enqueue: async (...args: any[]) => { calls.push(args[4].id); throw Object.assign(new Error("archived"), { code: "archived" }); } } as any;
  for (const name of ["first", "reset"]) {
    const notices = new DeckNotices(path.join(dir, `${name}.json`), queue); await notices.load();
    await notices.configure("demo", "source", noticePolicySchema.parse({ resultReady: true, windowSeconds: 0 }));
    await notices.tick([task("a")], 1000); await notices.tick([task("a")], 2000);
    assert.equal(notices.status("demo", "source").dead.length, 1);
  }
  assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
});

test("retention expires old history without re-emitting old outcomes", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "deck-notices-retain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "notices.json"); const calls: any[] = [];
  const notices = new DeckNotices(file, { enqueue: async (...args: any[]) => { calls.push(args); return { status: "queued" }; } } as any);
  await notices.load();
  await notices.configure("demo", "source", noticePolicySchema.parse({ resultReady: true, windowSeconds: 0 }));
  await notices.tick([task("a")], 1000);
  const later = 8 * 86400_000;
  await notices.tick([task("a")], later);
  const restored = new DeckNotices(file, { enqueue: async (...args: any[]) => { calls.push(args); return { status: "queued" }; } } as any);
  await restored.load();
  // Native timestamps can change on refresh: dedup must use the event key, never time.
  await restored.tick([task("a", { updatedAt: later + 1000 })], later + 1000);
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(disk.notices.length, 0); assert.equal(disk.digests.length, 0); assert.equal(calls.length, 1);
});
