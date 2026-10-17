import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  OpenCodeV2Adapter,
  v2ContentToItem,
  v2ErrorFor,
  v2MessagesToTurns,
} from "./opencode-v2-adapter.js";

function stubFetch(handler: (url: string, init?: any) => unknown) {
  return (async (url: any, init?: any) => handler(String(url), init)) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse() {
  return new Response("<!doctype html><html></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_demo",
    projectID: "global",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1000, updated: 2000 },
    title: "demo",
    location: { directory: "/work" },
    ...overrides,
  };
}

/** adapter 直连桩 serve：baseUrl 指向桩 fetch，跳过进程启动。 */
function wiredAdapter(handler: (url: string, init?: any) => unknown) {
  const adapter = new OpenCodeV2Adapter({ fetcher: stubFetch((url, init) =>
    new URL(url).pathname === "/api/model/default"
      ? jsonResponse({ data: { id: "strong", providerID: "acme" } })
      : handler(url, init),
  ) });
  (adapter as any).baseUrl = "http://127.0.0.1:9";
  (adapter as any).online = true;
  return adapter as any;
}

test("V2 lists sessions from the data envelope and hides subagent children", async () => {
  const adapter = wiredAdapter((url) => {
    if (url.endsWith("/api/session")) {
      return jsonResponse({
        data: [
          sessionFixture(),
          sessionFixture({ id: "ses_child", parentID: "ses_demo" }),
          sessionFixture({
            id: "ses_branch",
            parentID: "ses_demo",
            fork: { sessionID: "ses_demo", boundary: { type: "before", messageID: "u1" } },
          }),
        ],
      });
    }
    if (url.endsWith("/api/permission/request")) return jsonResponse({ data: [] });
    return jsonResponse({ data: [] });
  });
  await adapter.refreshAll();
  const snapshot = adapter.snapshot();
  assert.deepEqual(
    snapshot.threads.map((thread: any) => thread.id).sort(),
    ["ses_branch", "ses_demo"],
  );
  const demo = snapshot.threads.find((thread: any) => thread.id === "ses_demo");
  assert.equal(demo.agentId, "opencode-v2");
  assert.equal(demo.cwd, "/work");
  assert.equal(demo.providerId, "");
  assert.equal(demo.model, "default");
});

test("V2 createThread posts location.directory and persists the picked model", async () => {
  const seen: Array<{ url: string; body: any }> = [];
  const stored: Record<string, any> = {};
  const adapter = wiredAdapter((url, init) => {
    if (url.endsWith("/api/session") && init?.method === "POST") {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ data: sessionFixture() });
    }
    if (new URL(url).pathname === "/api/model") return jsonResponse({ data: [{ id: "strong", providerID: "acme", name: "Strong" }] });
    return jsonResponse({ data: [] });
  });
  (adapter as any).options.threadSettings = {
    get: () => undefined,
    update: async (_agent: string, _id: string, patch: any) => {
      Object.assign(stored, patch);
    },
  };
  const thread: any = await adapter.createThread("acme", {
    cwd: "/work",
    name: "demo",
    model: "acme/strong",
  });
  assert.deepEqual(seen[0].body, {
    location: { directory: "/work" },
    title: "demo",
    model: { providerID: "acme", id: "strong" },
  });
  assert.equal(thread.providerId, "acme");
  assert.equal(thread.model, "acme/strong");
  assert.equal(stored.model, "acme/strong");
});

test("V2 readThread pages newest-first and slices tails at user turns", async () => {
  const first = [
    { id: "u3", time: { created: 3000 }, type: "user", text: "third" },
    {
      id: "a2", time: { created: 2500 }, type: "assistant",
      content: [{ type: "text", text: "second reply" }],
    },
    { id: "u2", time: { created: 2000 }, type: "user", text: "second" },
  ];
  const second = [
    {
      id: "a1", time: { created: 1500 }, type: "assistant",
      content: [{ type: "reasoning", text: "thinking" }],
    },
    { id: "u1", time: { created: 1000 }, type: "user", text: "first" },
  ];
  const adapter = wiredAdapter((url) => {
    if (url.includes("/message")) {
      const cursor = new URL(url).searchParams.get("cursor");
      return jsonResponse(
        cursor
          ? { data: second, cursor: { previous: "c1", next: null } }
          : { data: first, cursor: { previous: null, next: "c0" } },
      );
    }
    if (/\/api\/session\/ses_demo$/.test(url)) return jsonResponse({ data: sessionFixture() });
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", {
    id: "ses_demo", agentId: "opencode-v2", cwd: "/work", name: "demo",
    providerId: "", model: "default", status: "idle", updatedAt: 1,
  });
  const full: any = await adapter.readThread("acme", "ses_demo", { turnLimit: 2 });
  assert.deepEqual(
    full.turns.map((turn: any) => turn.id),
    ["u2", "u3"],
  );
  assert.equal(full.hasMoreTurns, true);
  assert.ok(full.__cachedTailOmitted > 0);
  const u3 = full.turns[1];
  assert.equal(u3.items[0].type, "userMessage");
  const withFirst: any = await adapter.readThread("acme", "ses_demo");
  assert.equal(withFirst.turns[0].id, "u1");
  assert.equal(withFirst.turns[0].items.length, 2);
});

test("V2 tool content normalizes to commandExecution with aggregated output", () => {
  const message: any = { id: "a9", time: { created: 9000 }, type: "assistant" };
  const item: any = v2ContentToItem(
    {
      type: "tool", id: "p1", name: "acme-read",
      state: {
        status: "completed",
        input: { path: "/work/a.ts" },
        content: [{ type: "text", text: "file body" }],
      },
    },
    message,
  );
  assert.equal(item.type, "commandExecution");
  assert.equal(item.command, "acme-read");
  assert.equal(item.status, "completed");
  assert.equal(item.aggregatedOutput, "file body");
  assert.equal(
    v2ContentToItem({ type: "mystery", id: "p2" }, message).type,
    "extension",
  );
  const turns = v2MessagesToTurns([
    { id: "u1", time: { created: 1 }, type: "user", text: "hi" } as any,
    { id: "a1", time: { created: 2 }, type: "assistant", content: [{ type: "text", text: "yo" }] } as any,
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].items[1].type, "agentMessage");
});

test("V2 sendTurn sends top-level text and serializes concurrent sends", async () => {
  const seen: Array<{ body: any }> = [];
  const adapter = wiredAdapter((url, init) => {
    if (url.includes("/prompt")) {
      seen.push({ body: JSON.parse(String(init?.body)) });
      return jsonResponse({ data: { id: `msg_${seen.length}`, sessionID: "ses_demo" } });
    }
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", {
    id: "ses_demo", agentId: "opencode-v2", cwd: "/work", name: "demo",
    providerId: "", model: "default", status: "idle", updatedAt: 1,
  });
  const [first, second] = await Promise.all([
    adapter.sendTurn("acme", "ses_demo", "hello"),
    adapter.sendTurn("acme", "ses_demo", "world"),
  ]);
  assert.deepEqual(seen[0].body, { text: "hello" });
  assert.deepEqual(seen[1].body, { text: "world" });
  assert.equal(first.turnId, "msg_1");
  assert.equal((adapter as any).threads.get("ses_demo").status, "running");
  (adapter as any).threads.get("ses_demo").status = "idle";
  await assert.rejects(
    adapter.sendTurn("acme", "ses_demo", "   "),
    /请输入指令或图片/,
  );
});

test("V2 step events drive running/error and stream deltas as live items", async () => {
  const adapter = wiredAdapter(() => jsonResponse({ data: [] }));
  (adapter as any).threads.set("ses_demo", {
    id: "ses_demo", agentId: "opencode-v2", cwd: "/work", name: "demo",
    providerId: "", model: "default", status: "idle", updatedAt: 1,
  });
  const events: any[] = [];
  adapter.on("event", (event: any) => events.push(event));
  adapter.onEvent({
    id: "evt_1", type: "session.next.step.started",
    data: {
      sessionID: "ses_demo", assistantMessageID: "msg_live",
      agent: "build", model: { id: "strong", providerID: "acme" },
    },
  });
  assert.equal((adapter as any).threads.get("ses_demo").status, "running");
  assert.equal((adapter as any).threads.get("ses_demo").resolvedModel, "acme/strong");
  adapter.onEvent({
    id: "evt_2", type: "session.next.step.failed",
    data: { sessionID: "ses_demo", error: { type: "unknown", message: "boom" } },
  });
  const failed = (adapter as any).threads.get("ses_demo");
  assert.equal(failed.status, "error");
  assert.equal(failed.lastError, "boom");
  assert.ok(
    events.some((event) => event.data?.method === "thread/historyUpdated"),
    "失败必须触发历史刷新",
  );
  adapter.onEvent({
    id: "evt_3", type: "session.text.delta",
    data: { sessionID: "ses_demo", messageID: "msg_live", delta: "hi" },
  });
  const live = events.find((event) => event.data?.method === "item/updated");
  assert.equal(live.data.params.item.text, "hi");
  assert.equal(live.data.agentId, "opencode-v2");
});

test("V2 permission.asked opens approvals and decisions map to once/always/reject", async () => {
  const replies: Array<{ url: string; body: any }> = [];
  const adapter = wiredAdapter((url, init) => {
    if (url.includes("/reply")) {
      replies.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", {
    id: "ses_demo", agentId: "opencode-v2", cwd: "/work", name: "demo",
    providerId: "", model: "default", status: "idle", updatedAt: 1,
  });
  const events: any[] = [];
  adapter.on("event", (event: any) => events.push(event));
  adapter.onEvent({
    id: "evt_p", type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_demo", title: "run tests?" },
  });
  assert.equal((adapter as any).threads.get("ses_demo").status, "waiting");
  assert.ok(events.some((event) => event.type === "approval.requested"));
  await adapter.resolveApproval("per_1", { decision: "acceptForSession" });
  assert.deepEqual(replies[0].body, { decision: "always" });
  assert.ok(events.some((event) => event.type === "approval.resolved"));
  adapter.onEvent({
    id: "evt_p2", type: "permission.asked",
    data: { id: "per_2", sessionID: "ses_demo", title: "write file?" },
  });
  await adapter.resolveApproval("per_2", { decision: "decline" });
  assert.deepEqual(replies[1].body, { decision: "reject" });
});

test("V2 unwired routes fail loudly and rename keeps the Deck-side title", async () => {
  const adapter = wiredAdapter(() => htmlResponse());
  (adapter as any).threads.set("ses_demo", {
    id: "ses_demo", agentId: "opencode-v2", cwd: "/work", name: "demo",
    providerId: "", model: "default", status: "idle", updatedAt: 1,
  });
  await assert.rejects(adapter.deleteThread("acme", "ses_demo"), /尚未接线|找不到该接口/);
  await assert.rejects(adapter.forkThread("acme", "ses_demo"), /尚未接线|找不到该接口/);
  await assert.rejects(adapter.compactSession("acme", "ses_demo"), /尚未接线|找不到该接口/);
  await assert.rejects(
    adapter.updateThreadSettings("acme", "ses_demo", { reasoningEffort: "high" } as any),
    /推理强度/,
  );
  const renamed: any = await adapter.renameThread("acme", "ses_demo", "新名字");
  assert.equal(renamed.name, "新名字");
  assert.equal(
    v2ErrorFor("/api/session/x/fork", 200, "<!doctype html>", "text/html")?.message,
    "OpenCode V2 serve 尚未接线该接口（/api/session/x/fork），请升级 OpenCode V2 后重试",
  );
  assert.equal(
    v2ErrorFor("/api/x", 503, JSON.stringify({ _tag: "ServiceUnavailableError", message: "nope" }), "application/json")?.message,
    "OpenCode V2 暂不支持：nope",
  );
});

test("V2 listModels exposes default plus provider models", async () => {
  const adapter = wiredAdapter((url) => {
    if (new URL(url).pathname === "/api/model") {
      return jsonResponse({
        data: [
          { id: "strong", providerID: "acme", name: "Strong", capabilities: { input: ["text", "image"] } },
          { id: "old", providerID: "acme", name: "Old", enabled: false },
        ],
      });
    }
    if (url.endsWith("/api/provider")) {
      return jsonResponse({ data: [{ id: "acme", name: "Acme" }] });
    }
    return jsonResponse({ data: [] });
  });
  await adapter.refreshAll();
  const models = await adapter.listModels();
  assert.equal(models[0].id, "default");
  const strong = models.find((item: any) => item.id === "acme/strong");
  assert.equal(strong.displayName, "Strong");
  assert.equal(strong.supportsImages, true);
  assert.equal(models.some((item: any) => item.id === "acme/old"), false);
  const profiles = adapter.publicProfiles();
  assert.equal(profiles[0].agentId, "opencode-v2");
  const leaked = JSON.stringify([adapter.snapshot(), profiles]);
  assert.ok(!leaked.includes("apiKey"), "密钥不得进入快照与公开目录");
});

test("V2 start failure reports offline without killing the Deck", async () => {
  const adapter = new OpenCodeV2Adapter({
    bin: "opencode-v2-missing-for-test",
    spawnProcess: (() => {
      throw new Error("spawn ENOENT");
    }) as any,
  });
  await assert.rejects(adapter.startAll(), /ENOENT|启动失败|无响应/);
  assert.equal(adapter.isOnline(), false);
  assert.match(String(adapter.descriptor().error || ""), /ENOENT|启动失败|无响应/);
});

function demoThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_demo", agentId: "opencode-v2", cwd: "/work", name: "demo",
    providerId: "acme", model: "acme/strong", status: "idle", updatedAt: 1,
    ...overrides,
  };
}

test("V2 delete dedupes concurrent calls and purges local state", async () => {
  let calls = 0;
  const adapter = wiredAdapter((url, init) => {
    if (init?.method === "DELETE") {
      calls++;
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", demoThread());
  const [first, second] = await Promise.all([
    adapter.deleteThread("acme", "ses_demo"),
    adapter.deleteThread("acme", "ses_demo"),
  ]);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(calls, 1);
  assert.equal((adapter as any).threads.has("ses_demo"), false);
});

test("V2 fork maps lastTurnId to the next user boundary and persists the branch", async () => {
  const seen: Array<{ url: string; body: any }> = [];
  const persisted: Record<string, any> = {};
  const adapter = wiredAdapter((url, init) => {
    if (url.includes("/message")) {
      return jsonResponse({
        data: [
          { id: "u1", time: { created: 1000 }, type: "user", text: "first" },
          { id: "a1", time: { created: 1500 }, type: "assistant", content: [{ type: "text", text: "r1" }] },
          { id: "u2", time: { created: 2000 }, type: "user", text: "second" },
        ],
        cursor: { previous: null, next: null },
      });
    }
    if (url.includes("/fork")) {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ data: sessionFixture({ id: "ses_branch", parentID: "ses_demo" }) });
    }
    if (/\/api\/session\/ses_demo$/.test(url)) return jsonResponse({ data: sessionFixture() });
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", demoThread());
  (adapter as any).options.threadSettings = {
    get: () => undefined,
    update: async (_agent: string, _id: string, patch: any) => {
      Object.assign(persisted, patch);
    },
  };
  const branch: any = await adapter.forkThread("acme", "ses_demo", { lastTurnId: "u1" });
  assert.deepEqual(seen[0].body, { before: "u2" });
  assert.equal(branch.forkedFromId, "ses_demo");
  assert.equal(branch.model, "acme/strong");
  assert.equal(persisted.forkedFromId, "ses_demo");
  assert.ok(branch.name.includes("分支"));
});

test("V2 retryFromTurn forks at the turn itself and sends the new text", async () => {
  const prompts: string[] = [];
  const adapter = wiredAdapter((url, init) => {
    if (url.includes("/message")) {
      return jsonResponse({
        data: [{ id: "u1", time: { created: 1000 }, type: "user", text: "old" }],
        cursor: { previous: null, next: null },
      });
    }
    if (url.includes("/fork")) {
      return jsonResponse({ data: sessionFixture({ id: "ses_retry", parentID: "ses_demo" }) });
    }
    if (url.includes("/prompt")) {
      prompts.push(JSON.parse(String(init?.body)).text);
      return jsonResponse({ data: { id: "msg_r", sessionID: "ses_retry" } });
    }
    if (/\/api\/session\/ses_demo$/.test(url)) return jsonResponse({ data: sessionFixture() });
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", demoThread());
  const branch = await adapter.retryFromTurn("acme", "ses_demo", "u1", "new text");
  assert.equal(branch.id, "ses_retry", "frontend needs the new thread ID to navigate after retry");
  assert.deepEqual(prompts, ["new text"]);
  assert.equal((adapter as any).threads.get("ses_retry").status, "running");
});

test("V2 revert stages then commits and reports file summary", async () => {
  const calls: string[] = [];
  const adapter = wiredAdapter((url, init) => {
    calls.push(`${init?.method || "GET"} ${new URL(url).pathname}`);
    if (url.includes("/revert/stage")) {
      return jsonResponse({
        data: {
          messageID: "u1",
          files: [
            { file: "a.ts", patch: "@@+", additions: 3, deletions: 1, status: "modified" },
          ],
        },
      });
    }
    if (url.includes("/message")) {
      return jsonResponse({
        data: [{ id: "u1", time: { created: 1000 }, type: "user", text: "hi" }],
        cursor: { previous: null, next: null },
      });
    }
    if (/\/api\/session\/ses_demo$/.test(url)) return jsonResponse({ data: sessionFixture() });
    return new Response(null, { status: 204 });
  });
  (adapter as any).threads.set("ses_demo", demoThread());
  const summary: any = await adapter.revertSession("acme", "ses_demo");
  assert.deepEqual(summary, { messageID: "u1", files: 1, additions: 3, deletions: 1 });
  assert.ok(calls.includes("POST /api/session/ses_demo/revert/stage"));
  assert.ok(calls.includes("POST /api/session/ses_demo/revert/commit"));
  await adapter.unrevertSession("acme", "ses_demo");
  assert.ok(calls.includes("DELETE /api/session/ses_demo/revert"));
});

test("V2 runSessionCommand posts name plus args and marks running", async () => {
  const seen: Array<{ body: any }> = [];
  const adapter = wiredAdapter((url, init) => {
    seen.push({ body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  });
  (adapter as any).threads.set("ses_demo", demoThread());
  await adapter.runSessionCommand("acme", "ses_demo", "/init", "--force");
  assert.deepEqual(seen[0].body, { name: "init", text: "--force" });
  assert.equal((adapter as any).threads.get("ses_demo").status, "running");
});

test("V2 updateThreadSettings clears default and switches model with label", async () => {
  const switched: Array<{ url: string; body: any }> = [];
  const adapter = wiredAdapter((url, init) => {
    if (url.includes("/model") && init?.method === "POST") {
      switched.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }
    if (new URL(url).pathname === "/api/model") {
      return jsonResponse({
        data: [{ id: "strong", providerID: "acme", name: "Strong" }],
      });
    }
    return jsonResponse({ data: [] });
  });
  await adapter.refreshAll();
  (adapter as any).threads.set("ses_demo", demoThread());
  const cleared: any = await adapter.updateThreadSettings("acme", "ses_demo", { model: "" });
  assert.equal(cleared.model, "default");
  assert.equal(switched.length, 1);
  assert.deepEqual(switched[0].body, { model: { providerID: "acme", id: "strong" } });
  const updated: any = await adapter.updateThreadSettings("acme", "ses_demo", { model: "acme/strong" });
  assert.deepEqual(switched[0].body, { model: { providerID: "acme", id: "strong" } });
  assert.equal(updated.modelLabel, "Strong");
  await assert.rejects(
    adapter.updateThreadSettings("acme", "ses_demo", { model: "acme/unknown" }),
    /未知模型/,
  );
  await assert.rejects(
    adapter.createThread("acme", { cwd: "/work", model: "no-slash" }),
    /provider\/model/,
  );
});

test("V2 sendMessage honors the generic message contract", async () => {
  const adapter = wiredAdapter((url, init) => {
    if (url.includes("/prompt")) {
      return jsonResponse({ data: { id: "msg_m", sessionID: "ses_demo" } });
    }
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", demoThread({ status: "idle" }));
  const accepted: any = await adapter.sendMessage("acme", "ses_demo", { text: "hi" } as any);
  assert.equal(accepted.disposition, "started");
  assert.equal(accepted.turnId, "msg_m");
  await assert.rejects(
    adapter.sendMessage("acme", "ses_demo", { text: "   " } as any),
    /请输入/,
  );
});

test("V2 shares concurrent message reads across readThread calls", async () => {
  let calls = 0;
  const adapter = wiredAdapter((url) => {
    if (url.includes("/message")) {
      calls++;
      return jsonResponse({
        data: [{ id: "u1", time: { created: 1000 }, type: "user", text: "hi" }],
        cursor: { previous: null, next: null },
      });
    }
    if (/\/api\/session\/ses_demo$/.test(url)) return jsonResponse({ data: sessionFixture() });
    return jsonResponse({ data: [] });
  });
  (adapter as any).threads.set("ses_demo", demoThread());
  const [first, second]: any[] = await Promise.all([
    adapter.readThread("acme", "ses_demo", { turnLimit: 10 }),
    adapter.readThread("acme", "ses_demo", { turnLimit: 10 }),
  ]);
  assert.equal(first.turns.length, 1);
  assert.equal(second.turns.length, 1);
  // session.get 各一次，message 列表只发一次（第二个调用复用在途请求）。
  assert.equal(calls, 1);
});

test("V2 exposes the shared OpenCode identity in summaries and extension items", async () => {
  const adapter = new OpenCodeV2Adapter({
    agentId: "opencode",
    fetcher: stubFetch((url) => jsonResponse({ data: url.endsWith("/api/session") ? [sessionFixture()] : [] })),
  });
  (adapter as any).baseUrl = "http://127.0.0.1:9";
  await adapter.refreshAll();
  assert.equal(adapter.descriptor().name, "OpenCode");
  assert.equal(adapter.snapshot().threads[0].agentId, "opencode");
  const turns = v2MessagesToTurns([
    { id: "u_demo", type: "user", text: "demo" },
    { id: "s_demo", type: "system", text: "demo" },
  ], "opencode");
  assert.equal(turns[0].items[1].agentId, "opencode");
});


test("V2 authenticates REST and SSE and launches Windows npm shims via cmd", async () => {
  let childPassword = "";
  let spawned = false;
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 1234, stderr: new EventEmitter(), kill: () => true,
  }) as unknown as ChildProcess;
  const adapter = new OpenCodeV2Adapter({
    bin: "C:\\demo folder\\opencode.cmd", platform: "win32", port: 43210,
    killProcessTree: () => {},
    spawnProcess(command, args, options) {
      spawned = true;
      assert.equal(command, process.env.ComSpec || "cmd.exe");
      assert.equal(args[0], "/d");
      assert.match(args[3], /^call "C:/);
      assert.equal(options.windowsVerbatimArguments, true);
      childPassword = options.env.OPENCODE_PASSWORD || "";
      assert.ok(childPassword);
      assert.equal(childPassword, options.env.OPENCODE_SERVER_PASSWORD);
      return child;
    },
    fetcher: stubFetch((url, init) => {
      assert.ok(spawned);
      const path = new URL(url).pathname;
      calls.push({ path, authorization: new Headers(init.headers).get("Authorization") });
      if (path === "/api/event") {
        return new Response(new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.close(), { once: true });
          },
        }));
      }
      return jsonResponse({ data: [] });
    }),
  });
  try {
    await adapter.startAll();
    const authorization = `Basic ${Buffer.from(`opencode:${childPassword}`).toString("base64")}`;
    assert.ok(calls.some((call) => call.path === "/api/event"));
    assert.ok(calls.every((call) => call.authorization === authorization));
    assert.ok(!JSON.stringify([adapter.descriptor(), adapter.snapshot()]).includes(childPassword));
  } finally {
    adapter.restart();
  }
});

test("V2 stable events reach the shared frontend stream and retain a turn across tool steps", async () => {
  const { appendCodexEvent, collectStreamed } = await import("../../src/session/streaming.ts");
  const adapter = wiredAdapter(() => jsonResponse({ data: [] }));
  const thread = { id: "ses_demo", agentId: "opencode", cwd: "/work", name: "demo", providerId: "acme", model: "acme/demo", status: "idle", updatedAt: 1 };
  adapter.threads.set(thread.id, thread);
  let events: any[] = [];
  adapter.on("event", (event: any) => {
    if (event.type === "agent.event") events = appendCodexEvent(events, event.data);
  });
  const emit = (type: string, data: any = {}) => adapter.onEvent({ type, data: { sessionID: thread.id, ...data } });
  emit("session.inbox.delivered", { inboxID: "u1" });
  emit("session.step.started", { assistantMessageID: "a1" });
  emit("session.reasoning.delta", { assistantMessageID: "a1", ordinal: 0, delta: "think" });
  emit("session.text.delta", { assistantMessageID: "a1", ordinal: 1, delta: "hel" });
  emit("session.text.delta", { assistantMessageID: "a1", ordinal: 1, delta: "lo" });
  emit("session.tool.input.started", { assistantMessageID: "a1", id: "call_1", name: "shell" });
  emit("session.tool.called", { id: "call_1", input: { command: "printf demo" } });
  emit("session.tool.success", { id: "call_1", content: [{ type: "text", text: "demo" }] });
  emit("session.step.ended", { assistantMessageID: "a1", finish: "tool-calls" });
  assert.equal(thread.status, "running", "a model step must not end a tool-using turn");
  emit("session.step.started", { assistantMessageID: "a2" });
  assert.equal((thread as any).activeTurnId, "u1");
  const live = collectStreamed(events, "acme", thread.id, "u1", "opencode-v2");
  assert.equal(live.items.find((entry: any) => entry.item.type === "agentMessage")?.item.text, "hello");
  assert.equal(live.items.find((entry: any) => entry.item.type === "reasoning")?.item.summary, "think");
  const tool = live.items.find((entry: any) => entry.item.type === "commandExecution")?.item;
  assert.equal(tool.command, "printf demo");
  assert.equal(tool.aggregatedOutput, "demo");
  assert.equal(tool.status, "completed");
  emit("session.execution.succeeded");
  assert.equal(thread.status, "idle");
  assert.ok(events.some((event) => event.method === "turn/completed" && event.params.turn.id === "u1"));
});

test("V2 history uses native idle timestamps and stable stream item IDs", () => {
  const turns = v2MessagesToTurns([
    { id: "u1", type: "user", text: "hello", time: { created: 1000 } },
    { id: "a1", type: "assistant", time: { created: 1100 }, content: [{ type: "text", text: "reply" }] },
    { id: "i1", type: "idle", time: { created: 2500 }, outcome: "interrupted" },
  ] as any);
  assert.equal(turns[0].endedAt, 2500);
  assert.equal(turns[0].status, "interrupted");
  assert.equal(turns[0].items[1].id, "a1:text:0");
  assert.equal(turns[0].items.length, 2);
});

test("V2 stable permissions and keyed forms bind to their session and serialize answers", async () => {
  const { approvalBelongsToThread } = await import("../../src/session/approvals.ts");
  const requests: any[] = [];
  const adapter = wiredAdapter((url, init) => {
    requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(null, { status: 204 });
  });
  const thread = demoThread();
  adapter.threads.set("ses_demo", thread);
  adapter.onEvent({ type: "permission.asked", data: { id: "per_demo", sessionID: "ses_demo", action: "shell", resources: ["printf demo"] } });
  const permission = adapter.snapshot().approvals[0];
  assert.equal(permission.command, "printf demo");
  assert.ok(approvalBelongsToThread(permission, thread));
  await adapter.resolveApproval("per_demo", { decision: "accept" });
  assert.deepEqual(requests.at(-1).body, { decision: "once" });
  const form = { id: "frm_demo", sessionID: "ses_demo", title: "Questions", fields: [
    { key: "q0", title: "Demo", description: "Pick a demo option", type: "string", options: [{ label: "Alpha", value: "alpha_id" }] },
    { key: "q1", title: "Many", type: "multiselect", options: [{ label: "Beta", value: "beta_id" }] },
  ] };
  adapter.onEvent({ type: "form.created", data: { form } });
  const question = adapter.snapshot().approvals[0];
  assert.equal(question.kind, "question");
  assert.ok(approvalBelongsToThread(question, thread));
  assert.equal(question.request.params.questions[0].question, "Pick a demo option");
  await adapter.resolveApproval("frm_demo", { answers: [{ id: "q1", values: ["Beta"] }, { id: "q0", value: "Alpha" }] });
  assert.deepEqual(requests.at(-1).body, { answer: { q0: "alpha_id", q1: ["beta_id"] } });
  adapter.onEvent({ type: "form.created", data: { form } });
  await adapter.resolveApproval("frm_demo", { decision: "cancel" });
  assert.equal(requests.at(-1).method, "DELETE");
  assert.ok(requests.at(-1).url.endsWith("/form/frm_demo"));
});

test("V2 image attachments survive history reload", () => {
  const turns = v2MessagesToTurns([{ id: "u1", type: "user", text: "image", files: [{ mime: "image/png", data: "demo", name: "demo.png" }] }] as any);
  assert.deepEqual(turns[0].items[0].content[1], { type: "image", url: "data:image/png;base64,demo", name: "demo.png" });
});

test("V2 model catalogs honor project locations without contaminating other projects", async () => {
  const adapter = wiredAdapter((url) => {
    const location = new URL(url).searchParams.get("location[directory]");
    return jsonResponse({ data: new URL(url).pathname === "/api/model" ? [{ id: location === "/work/a" ? "one" : "two", providerID: "acme" }] : [] });
  });
  assert.equal((await adapter.listModels(undefined, "/work/a"))[1].model, "acme/one");
  assert.equal((await adapter.listModels(undefined, "/work/b"))[1].model, "acme/two");
  assert.equal((await adapter.listModels()).length, 1);
});

test("V2 SSE reconnect repairs history and project approvals, including CRLF event frames", async () => {
  const encoder = new TextEncoder();
  let connections = 0;
  const adapter = wiredAdapter((url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/event") {
      const first = ++connections === 1;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"server.connected","data":{}}\r\n\r\n'));
        if (first) controller.close();
        else init.signal.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (path === "/api/session") return jsonResponse({ data: [sessionFixture()] });
    if (path === "/api/permission/request") {
      assert.equal(new URL(url).searchParams.get("location[directory]"), "/work");
      return jsonResponse({ data: [{ id: "per_pending", sessionID: "ses_demo", action: "shell", resources: ["printf demo"] }] });
    }
    return jsonResponse({ data: [] });
  });
  adapter.threads.set("ses_demo", demoThread());
  const repaired = new Promise<void>((resolve) => adapter.on("event", (event: any) => {
    if (event.type === "agent.event" && event.data.method === "thread/historyUpdated") {
      adapter.eventAbort.abort();
      resolve();
    }
  }));
  adapter.subscribeEvents();
  await repaired;
  assert.equal(connections, 2);
  assert.equal(adapter.snapshot().approvals[0].id, "per_pending");
  assert.equal(adapter.threads.get("ses_demo").status, "waiting");
});

test("V2 interrupt transport failures remain visible and do not claim the turn stopped", async () => {
  const adapter = wiredAdapter(() => { throw new Error("demo connection refused"); });
  const thread = { ...demoThread(), status: "running", activeTurnId: "u1" };
  adapter.threads.set("ses_demo", thread);
  await assert.rejects(adapter.interrupt("acme", "ses_demo", "u1"), /connection refused/);
  assert.equal(thread.status, "running");
  assert.equal(thread.activeTurnId, "u1");
});
