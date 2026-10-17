import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadSummary } from "../types";
import { deleteSession, forkSession, getPendingSessionOperations } from "./operations";

const source = (id: string): ThreadSummary => ({
  id, agentId: "opencode", providerId: "acme", cwd: "/work",
  name: "demo", preview: "demo", status: "idle", updatedAt: 1,
});

test("OpenCode menu and turn forks use Agent routes and share a pending operation", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = ((url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as typeof fetch;
  try {
    const thread = source("demo-fork");
    const first = forkSession(thread, "u1");
    const snapshot = getPendingSessionOperations();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].name, "demo");
    assert.equal(snapshot[0].kind, "fork");
    assert.ok(snapshot[0].startedAt > 0);
    assert.equal(getPendingSessionOperations(), snapshot, "external-store snapshots stay stable between changes");
    const second = forkSession(thread, "u1");
    assert.equal(first, second);
    assert.equal(getPendingSessionOperations(), snapshot, "duplicate clicks must not reset the elapsed clock");
    await assert.rejects(deleteSession(thread), /操作正在进行/);
    await Promise.resolve();
    assert.deepEqual(calls, [{ url: "/api/agents/opencode/threads/demo-fork/fork", body: { lastTurnId: "u1" } }]);
    finish(Response.json({ ...thread, id: "branch" }));
    assert.equal((await first).id, "branch");
    assert.equal(getPendingSessionOperations().length, 0);
    const next = forkSession(thread);
    await Promise.resolve();
    finish(Response.json({ ...thread, id: "branch2" }));
    assert.equal((await next).id, "branch2");
  } finally { globalThis.fetch = original; }
});

test("failed delete remains retryable and requests a small success acknowledgement", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "/api/agents/opencode/threads/demo-delete?ack=1");
    assert.equal(init?.method, "DELETE");
    calls++;
    return calls === 1 ? Response.json({ error: "demo failure" }, { status: 500 })
      : Response.json({ ok: true });
  }) as typeof fetch;
  try {
    await assert.rejects(deleteSession(source("demo-delete")), /demo failure/);
    assert.equal(getPendingSessionOperations().length, 0, "failure must clear the progress indicator");
    assert.deepEqual(await deleteSession(source("demo-delete")), { ok: true });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
