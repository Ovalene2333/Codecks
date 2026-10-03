import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { acpLaunchSpec } from "./acp-client.js";
import {
  AcpAdapter,
  parseSessionListOutput,
  type AcpAgentSpec,
} from "./acp-adapter.js";
import { ThreadSettingsStore } from "../thread-settings.js";
import { AgentRegistry } from "./registry.js";
import { MessageDeliveryQueue } from "../message-delivery.js";

type Json = Record<string, any>;

interface RouteContext {
  respond: (result: any) => void;
  respondError: (code: number, message: string, data?: any) => void;
  notify: (method: string, params?: any) => void;
  /** agent → client 方向的 JSON-RPC 请求（session/request_permission 等）。 */
  request: (
    method: string,
    params: any,
    onResponse: (msg: Json) => void,
  ) => void;
}

/** 假 ACP agent 子进程：stdin 逐行收 JSON-RPC，handler 决定怎么回。 */
function fakeAcpProcess(options: {
  initialize?: Json;
  routes?: Record<string, (params: any, ctx: RouteContext) => void>;
  /** kill() 之后过多久才触发 exit；真实进程的退出总是滞后的。 */
  exitDelayMs?: number;
}) {
  const stdout = new PassThrough();
  const child = new EventEmitter() as any;
  child.pid = 24601;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  const seen: Json[] = [];
  let buffer = "";
  let serverRequestId = 0;
  const serverRequests = new Map<string, (msg: Json) => void>();
  const send = (msg: Json) => stdout.write(`${JSON.stringify(msg)}\n`);
  const handleMessage = (msg: Json) => {
    seen.push(msg);
    if (msg.method === "initialize") {
      send({
        id: msg.id,
        result: options.initialize ?? {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp", version: "0.0.1" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            sessionCapabilities: { list: {}, resume: {} },
          },
          authMethods: [],
        },
      });
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const route = options.routes?.[msg.method];
      if (!route) {
        send({
          id: msg.id,
          error: { code: -32601, message: `no route ${msg.method}` },
        });
        return;
      }
      route(msg.params, {
        respond: (result) => send({ id: msg.id, result }),
        respondError: (code, message, data) =>
          send({
            id: msg.id,
            error: { code, message, ...(data !== undefined ? { data } : {}) },
          }),
        notify: (method, params) => send({ method, params }),
        request: (method, params, onResponse) => {
          const id = `srv-${++serverRequestId}`;
          serverRequests.set(id, onResponse);
          send({ id, method, params });
        },
      });
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      const waiter = serverRequests.get(String(msg.id));
      if (waiter) {
        serverRequests.delete(String(msg.id));
        waiter(msg);
      }
    }
  };
  child.stdin = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    write(chunk: string) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          /* 测试里只发合法 JSON */
        }
      }
      return true;
    },
    on() {
      return this;
    },
  };
  child.kill = () => {
    child.killed = true;
    if (options.exitDelayMs)
      setTimeout(() => child.emit("exit", 0), options.exitDelayMs);
    else child.emit("exit", 0);
    return true;
  };
  return { child, seen, send };
}

const SPEC: AcpAgentSpec = {
  id: "devin",
  name: "Devin",
  command: "devin",
  args: ["acp"],
  env: { SECRET_TOKEN: "should-not-leak" },
};

function adapterWith(
  fake: ReturnType<typeof fakeAcpProcess>,
  options?: ConstructorParameters<typeof AcpAdapter>[1],
  spec: AcpAgentSpec = SPEC,
) {
  return new AcpAdapter(spec, {
    spawnProcess: (() => fake.child) as any,
    killProcessTree: () => {},
    requestTimeoutMs: 5_000,
    ...options,
  });
}

function collectEvents(adapter: AcpAdapter) {
  const events: { type: string; data: any }[] = [];
  adapter.on("event", (event) => events.push(event));
  return events;
}

// ------------------------------------------------------------- launch spec

test("acpLaunchSpec resolves cmd shims and plain binaries", () => {
  assert.deepEqual(
    acpLaunchSpec("devin", ["acp"], "linux", {}),
    { command: "devin", args: ["acp"] },
  );
  assert.deepEqual(
    acpLaunchSpec("C:\\Tools\\devin.exe", ["acp"], "win32", {}),
    { command: "C:\\Tools\\devin.exe", args: ["acp"] },
  );
  // Windows 下 PATH 里找不到 .exe 时回落 cmd /c xxx.cmd。
  const spec = acpLaunchSpec("devin", ["acp"], "win32", {
    ComSpec: "cmd.exe",
    Path: "",
  });
  assert.equal(spec.command, "cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "devin.cmd", "acp"]);
  // 带路径的 .cmd shim 直接包 cmd。
  assert.deepEqual(
    acpLaunchSpec("D:\\bin\\devin.cmd", ["acp"], "win32", {
      ComSpec: "cmd.exe",
    }).args,
    ["/d", "/s", "/c", "D:\\bin\\devin.cmd", "acp"],
  );
  assert.throws(() => acpLaunchSpec("devin\nrm -rf /", ["acp"], "linux", {}));
});

// ------------------------------------------------------- session list parse

test("parseSessionListOutput accepts arrays, wrappers and NDJSON", () => {
  assert.equal(
    parseSessionListOutput('[{"sessionId":"a","cwd":"/x"}]').length,
    1,
  );
  assert.equal(
    parseSessionListOutput('{"sessions":[{"sessionId":"b"}]}')[0].sessionId,
    "b",
  );
  const lines = '{"id":"1"}\n{"id":"2"}\nnot json\n';
  assert.deepEqual(
    parseSessionListOutput(lines, "/fallback").map((row) => row.id),
    ["1", "2"],
  );
  assert.equal(
    parseSessionListOutput('{"id":"c"}', "/fb")[0].cwd,
    "/fb",
  );
  assert.deepEqual(parseSessionListOutput("garbage"), []);
});

// ----------------------------------------------------------------- adapter

test("AcpAdapter starts, lists history and keeps secrets out of snapshot", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({
          sessions: [
            {
              sessionId: "remote-1",
              cwd: "D:\\proj",
              title: "远程会话",
              updatedAt: "2025-01-01T00:00:00Z",
            },
          ],
        }),
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();

  const descriptor = adapter.descriptor();
  assert.equal(descriptor.id, "devin");
  assert.equal(descriptor.online, true);
  assert.equal(descriptor.capabilities.approvals, true);
  assert.equal(descriptor.capabilities.fork, false);
  assert.equal(descriptor.capabilities.images, true);
  assert.equal(descriptor.capabilities.delete, false);

  const snapshot = adapter.snapshot();
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].agentId, "devin");
  assert.equal(snapshot.threads[0].id, "remote-1");
  assert.equal(snapshot.threads[0].controlMode, "history");
  assert.ok(!JSON.stringify(snapshot).includes("should-not-leak"));

  await adapter.restart();
  assert.equal(adapter.descriptor().online, false);
});

const CACHED_THREAD = {
  agentId: "devin",
  id: "t1",
  providerId: "devin-current",
  name: "旧会话",
  preview: "",
  cwd: "/x",
  model: "default",
  status: "idle" as const,
  updatedAt: 1_600_000_000_000,
};

test("session/list without timestamps keeps the cached updatedAt", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({
          sessions: [{ sessionId: "t1", cwd: "/x", title: "旧会话" }],
        }),
    },
  });
  const adapter = adapterWith(fake, { initialThreads: [CACHED_THREAD] });
  await adapter.startAll();

  assert.equal(
    adapter.snapshot().threads[0]?.updatedAt,
    CACHED_THREAD.updatedAt,
  );
});

test("load replay meta updates never refresh updatedAt", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({ sessions: [{ sessionId: "t1", cwd: "/x" }] }),
      "session/load": (_params, ctx) => {
        ctx.notify("session/update", {
          sessionId: "t1",
          update: { sessionUpdate: "session_info_update", title: "回放标题" },
        });
        ctx.notify("session/update", {
          sessionId: "t1",
          update: { sessionUpdate: "usage_update", used: 10, size: 100 },
        });
        ctx.respond({});
      },
    },
  });
  const adapter = adapterWith(fake, { initialThreads: [CACHED_THREAD] });
  await adapter.startAll();
  await adapter.readThread("devin-current", "t1");

  const thread = adapter.snapshot().threads[0];
  assert.equal(thread?.updatedAt, CACHED_THREAD.updatedAt);
  assert.equal(thread?.name, "回放标题");
});

test("listSessions field mapping adapts non-standard CLI output", async () => {
  const fake = fakeAcpProcess({
    initialize: {
      protocolVersion: 1,
      agentInfo: { name: "fake", version: "0" },
      agentCapabilities: { loadSession: false, sessionCapabilities: {} },
      authMethods: [],
    },
  });
  const spec: AcpAgentSpec = {
    id: "myagent",
    name: "My Agent",
    command: "my-agent",
    args: ["acp"],
    listSessions: {
      args: ["sessions", "--json"],
      fields: { sessionId: "sid", updatedAt: "seen", locked: "held" },
    },
  };
  const adapter = adapterWith(
    fake,
    {
      execListCommand: async () =>
        JSON.stringify([
          {
            sid: "a1",
            directory: "/work",
            seen: "2024-05-01T00:00:00Z",
            held: true,
          },
        ]),
    },
    spec,
  );
  await adapter.startAll();

  const thread = adapter.snapshot().threads[0];
  assert.equal(thread?.id, "a1");
  assert.equal(thread?.cwd, "/work");
  assert.equal(thread?.updatedAt, Date.parse("2024-05-01T00:00:00Z"));
  assert.equal(thread?.locked, true);
});

test("createThread maps session/new and carries modes", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (params, ctx) => {
        assert.equal(params.cwd, "D:\\proj");
        ctx.respond({
          sessionId: "s-1",
          modes: {
            currentModeId: "normal",
            availableModes: [
              { id: "normal", name: "Normal" },
              { id: "plan", name: "Plan" },
            ],
          },
        });
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  const thread = (await adapter.createThread("", {
    cwd: "D:\\proj",
    name: "测试会话",
  })) as any;
  assert.equal(thread.id, "s-1");
  assert.equal(thread.agentId, "devin");
  assert.equal(thread.sessionMode, "normal");
  assert.equal(thread.sessionModes.length, 2);
  assert.equal(thread.controlMode, "managed");
});

test("sendTurn streams chunks and completes the turn", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-2" }),
      "session/prompt": (params, ctx) => {
        assert.equal(params.sessionId, "s-2");
        assert.equal(params.prompt[0].text, "你好");
        ctx.notify("session/update", {
          sessionId: "s-2",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "正在" },
          },
        });
        ctx.notify("session/update", {
          sessionId: "s-2",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            kind: "execute",
            status: "in_progress",
            title: "ls",
            rawInput: { command: "ls -la" },
          },
        });
        ctx.notify("session/update", {
          sessionId: "s-2",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "ok" } },
            ],
          },
        });
        ctx.notify("session/update", {
          sessionId: "s-2",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "处理" },
          },
        });
        ctx.respond({ stopReason: "end_turn" });
      },
    },
  });
  const adapter = adapterWith(fake);
  const events = collectEvents(adapter);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj" });
  await adapter.sendTurn("", "s-2", "你好");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const agentEvents = events
    .filter((event) => event.type === "agent.event")
    .map((event) => event.data);
  assert.ok(
    agentEvents.some(
      (event) =>
        event.method === "item/agentMessage/delta" &&
        event.params.delta === "正在",
    ),
  );
  assert.ok(
    agentEvents.some(
      (event) =>
        event.method === "item/completed" &&
        event.params.item.id === "acp-tool-t1",
    ),
  );
  assert.ok(
    agentEvents.some((event) => event.method === "turn/completed"),
  );
  const thread = adapter.snapshot().threads[0];
  assert.equal(thread.status, "idle");

  const full = (await adapter.readThread("", "s-2")) as any;
  // 被工具调用隔开的两段文本应保持交错顺序，而不是黏成一条消息。
  const types = full.turns[0].items.map((item: any) => item.type);
  assert.deepEqual(types, [
    "userMessage",
    "agentMessage",
    "commandExecution",
    "agentMessage",
  ]);
  const messages = full.turns[0].items.filter(
    (item: any) => item.type === "agentMessage",
  );
  assert.deepEqual(
    messages.map((item: any) => item.text),
    ["正在", "处理"],
  );
});

test("tool items do not retain or emit raw ACP payloads", async () => {
  const big = `${"x".repeat(80 * 1024)}\nTAIL`;
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-big" }),
      "session/prompt": (_params, ctx) => {
        ctx.notify("session/update", {
          sessionId: "s-big",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "edit-1",
            kind: "edit",
            status: "in_progress",
            title: "Write big.ts",
            rawInput: { fileText: big },
            content: [
              { type: "diff", path: "/tmp/big.ts", oldText: big, newText: big },
            ],
          },
        });
        ctx.notify("session/update", {
          sessionId: "s-big",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fetch-1",
            kind: "fetch",
            status: "completed",
            title: "fetch",
            rawInput: { url: "https://x", blob: big },
          },
        });
        ctx.notify("session/update", {
          sessionId: "s-big",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "edit-1",
            status: "completed",
          },
        });
        ctx.respond({ stopReason: "end_turn" });
      },
    },
  });
  const adapter = adapterWith(fake);
  const events = collectEvents(adapter);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "/tmp" });
  await adapter.sendTurn("", "s-big", "go");
  await new Promise((resolve) => setTimeout(resolve, 20));

  // __raw/rawInput 字段不再随事件流或 readThread 出栈：此前每个 tool item
  // 都把整份 ACP 原始载荷推给每个客户端并永久留在 session 里。
  const wire = JSON.stringify(
    events.filter((event) => event.type === "agent.event"),
  );
  assert.ok(!wire.includes('"__raw"'));
  assert.ok(!wire.includes("fileText"), "rawInput 不应出现在事件里");

  const full = (await adapter.readThread("", "s-big")) as any;
  const items = full.turns.flatMap((turn: any) => turn.items);
  for (const item of items) assert.ok(!("__raw" in item));

  // rawInput 挂到 item 的 input/arguments 前会逐字段截断长字符串。
  const fetchItem = items.find(
    (entry: any) => entry.id === "acp-tool-fetch-1",
  );
  assert.ok(fetchItem.arguments.blob.length <= 33 * 1024);
  assert.ok(fetchItem.arguments.blob.endsWith("TAIL"));
});

test("long tool output keeps only the tail", async () => {
  const tail = "TAIL-MARKER";
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-out" }),
      "session/prompt": (_params, ctx) => {
        ctx.notify("session/update", {
          sessionId: "s-out",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "sh-1",
            kind: "execute",
            status: "completed",
            title: "flood",
            rawInput: { command: "flood" },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: `${"y".repeat(600 * 1024)}\n${tail}`,
                },
              },
            ],
          },
        });
        ctx.respond({ stopReason: "end_turn" });
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "/tmp" });
  await adapter.sendTurn("", "s-out", "go");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const full = (await adapter.readThread("", "s-out")) as any;
  const item = full.turns[0].items.find(
    (entry: any) => entry.id === "acp-tool-sh-1",
  );
  assert.ok(item.aggregatedOutput.endsWith(tail));
  assert.ok(item.aggregatedOutput.length < 520 * 1024);
  assert.ok(item.aggregatedOutput.startsWith("…"));
});

test("permission request becomes an approval and resolves back to the agent", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-3" }),
      "session/prompt": (_params, ctx) => {
        // prompt 的 respond 在 permission 应答之后发出（onResponse 里）。
        ctx.request(
          "session/request_permission",
          {
            sessionId: "s-3",
            toolCall: {
              toolCallId: "t9",
              kind: "execute",
              title: "rm -rf build",
              rawInput: { command: "rm -rf build" },
            },
            options: [
              { optionId: "allow-once", name: "允许", kind: "allow_once" },
              { optionId: "reject", name: "拒绝", kind: "reject_once" },
            ],
          },
          () => {
            ctx.notify("session/update", {
              sessionId: "s-3",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "done" },
              },
            });
            ctx.respond({ stopReason: "end_turn" });
          },
        );
      },
    },
  });
  const adapter = adapterWith(fake);
  const events = collectEvents(adapter);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj" });
  const turnDone = adapter.sendTurn("", "s-3", "清理");
  await new Promise((resolve) => setTimeout(resolve, 30));

  const approval = adapter.snapshot().approvals[0] as any;
  assert.ok(approval, "应产生一条待审批");
  assert.equal(approval.agentId, "devin");
  assert.equal(approval.kind, "command");
  assert.equal(approval.command, "rm -rf build");
  assert.ok(approval.availableDecisions.includes("accept"));
  assert.ok(
    events.some((event) => event.type === "approval.requested"),
  );

  let promptFinished = false;
  void turnDone.then(() => (promptFinished = true));
  await adapter.resolveApproval(approval.id, { decision: "accept" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(promptFinished);
  assert.equal(adapter.snapshot().approvals.length, 0);
  // 应答应该是 selected + allow-once。
  assert.ok(
    fake.seen.some(
      (msg) =>
        msg.id === "srv-1" &&
        msg.result?.outcome?.outcome === "selected" &&
        msg.result?.outcome?.optionId === "allow-once",
    ),
  );
});

test("decline maps to reject option; cancel maps to cancelled outcome", async () => {
  const outcomes: any[] = [];
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-4" }),
      "session/prompt": (_params, ctx) => {
        ctx.request(
          "session/request_permission",
          {
            sessionId: "s-4",
            toolCall: { toolCallId: "t1", kind: "other", title: "probe" },
            options: [
              { optionId: "a", name: "允许", kind: "allow_once" },
              { optionId: "r", name: "拒绝", kind: "reject_once" },
            ],
          },
          (answer) => {
            outcomes.push(answer.result?.outcome);
            ctx.respond({ stopReason: "refusal" });
          },
        );
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj" });
  await adapter.sendTurn("", "s-4", "go");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const approval = adapter.snapshot().approvals[0];
  await adapter.resolveApproval(approval.id, { decision: "decline" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(outcomes[0], { outcome: "selected", optionId: "r" });
  const thread = adapter.snapshot().threads[0];
  assert.equal(thread.status, "error"); // refusal → failed turn
});

test("devin-style minimal toolCall resolves to command card and session option", async () => {
  const outcomes: any[] = [];
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-6" }),
      "session/prompt": (_params, ctx) => {
        // devin 先发完整 tool_call update，request_permission 里的 toolCall
        // 只剩 {toolCallId,_meta} 快照；kind/title/rawInput 要按 id 补回。
        ctx.notify("session/update", {
          sessionId: "s-6",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            title: "Read /etc/hostname",
            rawInput: { command: "cat /etc/hostname" },
          },
        });
        ctx.request(
          "session/request_permission",
          {
            sessionId: "s-6",
            toolCall: {
              toolCallId: "call-1",
              _meta: {
                "cognition.ai/editableCommand": "cat /etc/hostname",
              },
            },
            // devin 的真实 options：多个选项共享 allow_always kind。
            options: [
              { optionId: "allow_once", name: "Allow", kind: "allow_once" },
              {
                optionId: "allow_session",
                name: "Yes, allow `cat` commands (this session)",
                kind: "allow_always",
              },
              {
                optionId: "allow_always",
                name: "Yes, always allow `cat` commands in `tmp`",
                kind: "allow_always",
              },
              {
                optionId: "allow_always_global",
                name: "Yes, always allow `cat` commands in all projects",
                kind: "allow_always",
              },
              {
                optionId: "switch_bypass",
                name: "Yes, switch to bypass mode",
                kind: "allow_always",
              },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
          (answer) => {
            outcomes.push(answer.result?.outcome);
            ctx.respond({ stopReason: "end_turn" });
          },
        );
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "/tmp" });
  await adapter.sendTurn("", "s-6", "go");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const approval = adapter.snapshot().approvals[0] as any;
  assert.ok(approval);
  // kind 缺失时也要落成 command 卡（决策按钮），不能走 permission 勾选卡——
  // 那个模板回的是 {permissions,scope}，server 会缺省 decline 全部拒绝。
  assert.equal(approval.kind, "command");
  assert.equal(approval.command, "cat /etc/hostname");
  assert.ok(approval.availableDecisions.includes("acceptForSession"));
  await adapter.resolveApproval(approval.id, {
    decision: "acceptForSession",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 「本会话」必须挑 allow_session，而不是碰巧的第一个 allow_always。
  assert.deepEqual(outcomes[0], {
    outcome: "selected",
    optionId: "allow_session",
  });

  // 第二轮：前端直接回传 agent 的 optionId，原样透传不映射。
  await adapter.sendTurn("", "s-6", "again");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = adapter.snapshot().approvals[0] as any;
  assert.ok(second);
  await assert.rejects(
    () => adapter.resolveApproval(second.id, { optionId: "nope" }),
    /选项已失效/,
  );
  assert.ok(
    adapter.snapshot().approvals.length,
    "无效 optionId 不得消费待审批",
  );
  await adapter.resolveApproval(second.id, {
    optionId: "allow_always_global",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(outcomes[1], {
    outcome: "selected",
    optionId: "allow_always_global",
  });
});

test("interrupt sends session/cancel", async () => {
  let turnId = "";
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-5" }),
      "session/prompt": (_params, ctx) => {
        // 永不返回，等 cancel。
        ctx.notify("session/update", {
          sessionId: "s-5",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "…" },
          },
        });
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj" });
  const started = (await adapter.sendTurn("", "s-5", "long task")) as any;
  turnId = started.turn.id;
  await adapter.interrupt("", "s-5", turnId);
  assert.ok(
    fake.seen.some(
      (msg) =>
        msg.method === "session/cancel" && msg.params?.sessionId === "s-5",
    ),
  );
  await adapter.restart();
});

test("readThread replays session/load history", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({
          sessions: [{ sessionId: "hist-1", cwd: "D:\\proj" }],
        }),
      "session/load": (params, ctx) => {
        ctx.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "旧问题" },
          },
        });
        ctx.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "旧回答" },
          },
        });
        ctx.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tt",
            kind: "read",
            status: "completed",
            title: "读取文件",
            locations: [{ path: "D:\\proj\\a.ts" }],
          },
        });
        ctx.respond({});
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  const full = (await adapter.readThread("", "hist-1")) as any;
  assert.equal(full.turns.length, 1);
  const items = full.turns[0].items;
  assert.equal(items[0].type, "userMessage");
  assert.equal(items[1].type, "agentMessage");
  assert.equal(items[1].text, "旧回答");
  assert.equal(items[2].type, "commandExecution");
  assert.equal(items[2].status, "completed");
});

test("readThread does not re-load an already-live session", async () => {
  let loads = 0;
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({ sessions: [{ sessionId: "hist-1", cwd: "/x" }] }),
      "session/load": (params, ctx) => {
        loads += 1;
        ctx.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "旧问题" },
          },
        });
        ctx.respond({});
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.readThread("", "hist-1");
  await adapter.readThread("", "hist-1");
  await adapter.readThread("", "hist-1");
  // agent 端每次 session/load 都会新建一份会话状态；live 会话靠
  // session/update 流保鲜，重复回放是纯开销。
  assert.equal(loads, 1);
});

test("ACP live user messages and replay preserve image parts for bubble reconciliation", async () => {
  const fake = fakeAcpProcess({ routes: {
    "session/list": (_params, ctx) => ctx.respond({ sessions: [{ sessionId: "images", cwd: "/x" }] }),
    "session/load": (params, ctx) => {
      for (const content of [{ type: "text", text: "看看图片" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" }]) ctx.notify("session/update", {
        sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content },
      });
      ctx.respond({});
    },
    "session/prompt": (_params, ctx) => ctx.respond({ stopReason: "end_turn" }),
  } });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  const replay = await adapter.readThread("", "images") as any;
  assert.deepEqual(replay.turns[0].items[0].content, [
    { type: "text", text: "看看图片" },
    { type: "image", url: "data:image/png;base64,aGVsbG8=", name: undefined },
  ]);
  await adapter.sendTurn("", "images", "新图片", [{ url: "data:image/png;base64,aGVsbG8=", name: "sample.png" }]);
  const live = await adapter.readThread("", "images") as any;
  assert.deepEqual(live.turns.at(-1).items[0].content, [
    { type: "text", text: "新图片" },
    { type: "image", url: "data:image/png;base64,aGVsbG8=", name: "sample.png" },
  ]);
  await adapter.restart();
});

test("per-turn model snapshots follow replay turns after a session/load", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-acp-turn-models-"));
  const settings = new ThreadSettingsStore(dir);
  await settings.load();
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-m" }),
      "session/prompt": (_params, ctx) =>
        ctx.respond({ stopReason: "end_turn" }),
      "session/load": (params, ctx) => {
        for (const text of ["一", "二"]) {
          ctx.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text },
            },
          });
          ctx.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `答${text}` },
            },
          });
        }
        ctx.respond({});
      },
    },
  });
  const adapter = adapterWith(fake, { threadSettings: settings });
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj", model: "sol" });
  await adapter.sendTurn("", "s-m", "一");
  // 会话中途切换模型：之后的 turn 记新模型。
  await adapter.updateThreadSettings("", "s-m", { model: "luna" });
  await adapter.sendTurn("", "s-m", "二");
  await new Promise((resolve) => setTimeout(resolve, 20));

  // session/load 回放把 turn 重建成 acp-replay-N 合成 id，按位置回填快照。
  const full = (await adapter.readThread("", "s-m")) as any;
  assert.equal(full.turns.length, 2);
  assert.equal(full.turns[0].model, "sol");
  assert.equal(full.turns[1].model, "luna");
});

test("sendTurn on a history session resumes it first", async () => {
  const resumed: string[] = [];
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({ sessions: [{ sessionId: "hist-2", cwd: "D:\\proj" }] }),
      "session/resume": (params, ctx) => {
        resumed.push(params.sessionId);
        ctx.respond({});
      },
      "session/prompt": (_params, ctx) =>
        ctx.respond({ stopReason: "end_turn" }),
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.sendTurn("", "hist-2", "继续");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resumed, ["hist-2"]);
});

test("agents without history methods keep cached threads and degrade", async () => {
  const fake = fakeAcpProcess({
    initialize: {
      protocolVersion: 1,
      agentCapabilities: {},
    },
    routes: {},
  });
  const adapter = adapterWith(fake, {
    initialThreads: [
      {
        agentId: "devin",
        id: "cached-1",
        providerId: "devin-current",
        name: "缓存会话",
        preview: "…",
        cwd: "D:\\proj",
        model: "default",
        status: "running",
        updatedAt: Date.now(),
      } as any,
    ],
  });
  await adapter.startAll();
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].id, "cached-1");
  // 缓存里残留的 running 对新进程无意义，应回退为 idle。
  assert.equal(snapshot.threads[0].status, "idle");
  assert.equal(adapter.descriptor().capabilities.images, false);
  await assert.rejects(() =>
    adapter.sendTurn("", "cached-1", "hi"),
  );
});

test("malformed JSON lines are logged and the protocol keeps working", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-9" }),
    },
  });
  const adapter = adapterWith(fake);
  const client = (adapter as any).client;
  const logs: string[] = [];
  client.on("log", (line: string) => logs.push(line));
  await adapter.startAll();
  fake.child.stdout.write("this is not json\n{broken\n");
  await adapter.createThread("", { cwd: "D:\\proj" });
  assert.ok(logs.some((line) => line.includes("无法解析")));
});

test("outbound JSON-RPC messages carry jsonrpc 2.0", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-j" }),
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj" });
  assert.ok(fake.seen.length > 0);
  assert.ok(fake.seen.every((msg) => msg.jsonrpc === "2.0"));
});

test("id:null error rejects the in-flight request instead of timing out", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": () => {
        // 不响应：模拟严格 agent 拒绝解析后不回正常响应的场景。
      },
    },
  });
  const adapter = adapterWith(fake);
  const client = (adapter as any).client;
  const logs: string[] = [];
  client.on("log", (line: string) => logs.push(line));
  await adapter.startAll();
  const request = client.request("session/new", {
    cwd: "D:\\proj",
    mcpServers: [],
  });
  // 严格 agent 对畸形请求回 id:null 的 Parse error。
  fake.child.stdout.write(
    `${JSON.stringify({
      id: null,
      error: { code: -32700, message: "Parse error" },
    })}\n`,
  );
  await assert.rejects(request, /Parse error/);
  assert.ok(logs.some((line) => line.includes("Parse error")));
});

test("locked sessions are flagged from session/list and fail with a friendly error", async () => {
  const fake = fakeAcpProcess({
    // 去掉 resume 能力，ensureLive 才会走 session/load 路径命中锁错误。
    initialize: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {} },
      },
    },
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({
          sessions: [
            {
              sessionId: "busy-1",
              cwd: "D:\\proj",
              title: "被占用的会话",
              _meta: { "cognition.ai/isLocked": true },
            },
            { sessionId: "free-1", cwd: "D:\\proj" },
          ],
        }),
      "session/load": (params, ctx) => {
        if (params.sessionId === "busy-1")
          return ctx.respondError(
            -32015,
            "Session 'busy-1' is already open in another process.",
            { "cognition.ai/errorKind": "session_locked" },
          );
        ctx.respond({});
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  const threads = adapter.snapshot().threads;
  const busy = threads.find((t) => t.id === "busy-1")!;
  const free = threads.find((t) => t.id === "free-1")!;
  assert.equal(busy.locked, true);
  assert.equal(free.locked, undefined);

  await assert.rejects(adapter.sendTurn("", "busy-1", "hi"), /占用|锁定/);
  assert.equal(
    adapter.snapshot().threads.find((t) => t.id === "busy-1")!.locked,
    true,
  );
});

test("lock flag clears when a later session/list reports the session free", async () => {
  let locked = true;
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({
          sessions: [
            {
              sessionId: "s-lock",
              cwd: "D:\\proj",
              ...(locked
                ? { _meta: { "cognition.ai/isLocked": true } }
                : {}),
            },
          ],
        }),
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  assert.equal(adapter.snapshot().threads[0].locked, true);
  locked = false;
  await adapter.refreshAll();
  assert.equal(adapter.snapshot().threads[0].locked, undefined);
});

test("process exit mid-turn fails the turn and marks thread offline", async () => {
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-8" }),
      "session/prompt": () => {
        // 不响应：模拟进程挂死直到退出。
      },
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "D:\\proj" });
  await adapter.sendTurn("", "s-8", "run");
  await new Promise((resolve) => setTimeout(resolve, 10));
  fake.child.emit("exit", 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const thread = adapter.snapshot().threads[0];
  assert.equal(thread.status, "error");
  assert.ok(thread.lastError);
});

test("availableCommands: replay updates apply, session/new seeds, runSessionCommand prompts", async () => {
  const prompts: any[] = [];
  const fake = fakeAcpProcess({
    routes: {
      "session/list": (_params, ctx) =>
        ctx.respond({ sessions: [{ sessionId: "hist-c", cwd: "D:\\proj" }] }),
      "session/load": (params, ctx) => {
        // 回放期间推 available_commands_update，此前会被 replay 吞掉。
        ctx.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "help", description: "帮助" },
              { name: "context" },
            ],
          },
        });
        ctx.notify("session/update", {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "旧消息" },
          },
        });
        ctx.respond({});
      },
      "session/new": (_params, ctx) =>
        ctx.respond({
          sessionId: "s-cmd",
          commands: {
            availableCommands: [{ name: "btw", description: "旁支" }],
          },
        }),
      "session/prompt": (params, ctx) => {
        prompts.push(params);
        ctx.respond({ stopReason: "end_turn" });
      },
    },
  });
  const adapter = adapterWith(fake);
  const events = collectEvents(adapter);
  await adapter.startAll();

  // load 回放中的 available_commands_update 要落进 session.commands。
  await adapter.readThread("", "hist-c");
  const loaded = await adapter.listSessionCommands("", "hist-c");
  assert.deepEqual(
    loaded.map((command) => command.name),
    ["help", "context"],
  );
  // 同时推 agent.event 给前端刷新补全。
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent.event" &&
        event.data.method === "session/commands" &&
        event.data.params.threadId === "hist-c" &&
        event.data.params.commands.length === 2,
    ),
  );

  // session/new 响应里顺带的 commands 也接收。
  await adapter.createThread("", { cwd: "D:\\proj" });
  const created = await adapter.listSessionCommands("", "s-cmd");
  assert.deepEqual(
    created.map((command) => command.name),
    ["btw"],
  );

  // 斜杠命令按 /cmd args 原样作为 prompt 发送。
  await adapter.runSessionCommand("", "s-cmd", "/btw", "看看进度");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const prompt = prompts.find(
    (params) => params.sessionId === "s-cmd",
  );
  assert.equal(prompt.prompt[0].text, "/btw 看看进度");
});

test("session/new models feed listModels; set_model and fork work", async () => {
  const setModelCalls: Json[] = [];
  const fake = fakeAcpProcess({
    initialize: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
      },
      authMethods: [],
    },
    routes: {
      "session/new": (_params, ctx) =>
        ctx.respond({
          sessionId: "s-m",
          models: {
            currentModelId: "default",
            availableModels: [
              { modelId: "default", name: "Default" },
              { modelId: "opus", name: "Opus" },
              { modelId: "haiku", name: "Haiku" },
            ],
          },
        }),
      "session/set_model": (params, ctx) => {
        setModelCalls.push(params);
        ctx.respond({});
      },
      "session/fork": (params, ctx) => {
        assert.equal(params.sessionId, "s-m");
        ctx.respond({ sessionId: "s-fork" });
      },
      "session/list": (_params, ctx) => ctx.respond({ sessions: [] }),
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  const thread = await adapter.createThread("", { cwd: "/tmp" });
  assert.equal(thread.id, "s-m");
  assert.equal(thread.resolvedModel, "default");
  assert.equal(adapter.descriptor().capabilities.models, true);
  assert.equal(adapter.descriptor().capabilities.fork, true);
  assert.deepEqual(
    (await adapter.listModels()).map((model) => model.id),
    ["default", "opus", "haiku"],
  );

  await adapter.updateThreadSettings("", "s-m", { model: "opus" });
  assert.equal(setModelCalls.length, 1);
  assert.equal(setModelCalls[0].modelId, "opus");

  const forked = (await adapter.forkThread("", "s-m")) as any;
  assert.equal(forked.id, "s-fork");
  assert.equal(forked.forkedFromId, "s-m");
  assert.equal(forked.name.includes("分支"), true);
});

test("sendTurn during a running turn queues and drains FIFO", async () => {
  const held: RouteContext[] = [];
  const prompts: Json[] = [];
  const fake = fakeAcpProcess({
    routes: {
      "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-q" }),
      // prompt 先不回应，挂起模拟进行中的 turn
      "session/prompt": (params, ctx) => {
        prompts.push(params);
        held.push(ctx);
      },
      "session/list": (_params, ctx) => ctx.respond({ sessions: [] }),
    },
  });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "/tmp" });

  const first = await adapter.sendTurn("", "s-q", "first");
  assert.equal(first.turn.status, "inProgress");
  const second = await adapter.sendTurn("", "s-q", "second");
  assert.equal(second.turn.status, "queued");
  const third = await adapter.sendTurn("", "s-q", "third");
  assert.equal(third.turn.status, "queued");
  assert.equal(prompts.length, 1);

  held.shift()!.respond({ stopReason: "end_turn" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].prompt[0].text, "second");

  held.shift()!.respond({ stopReason: "end_turn" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(prompts.length, 3);
  assert.equal(prompts[2].prompt[0].text, "third");

  held.shift()!.respond({ stopReason: "end_turn" });
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("descriptor reports fallbackFor only for fallback agents", () => {
  const fake = fakeAcpProcess({});
  assert.equal(adapterWith(fake).descriptor().fallbackFor, undefined);

  const fallback = adapterWith(fake, undefined, {
    ...SPEC,
    id: "claude-acp",
    name: "Claude (ACP)",
    fallbackFor: "claude",
  });
  assert.equal(fallback.descriptor().fallbackFor, "claude");
});

test("message API queue remains FIFO after cancelling the active ACP prompt", async (t) => {
  const held: RouteContext[] = [];
  const prompts: Json[] = [];
  const fake = fakeAcpProcess({ routes: {
    "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-message" }),
    "session/prompt": (params, ctx) => { prompts.push(params); held.push(ctx); },
  } });
  const adapter = adapterWith(fake);
  t.after(() => adapter.restart());
  await adapter.startAll();
  await adapter.createThread("", { cwd: "/tmp" });
  const first = await adapter.sendMessage("", "s-message", { text: "first", mode: "start" });
  const second = await adapter.sendMessage("", "s-message", { text: "second" });
  assert.equal(first.disposition, "started");
  assert.equal(second.disposition, "queued");
  assert.equal(second.queueDurability, "memory");
  await assert.rejects(adapter.sendMessage("", "s-message", {
    text: "strict append", mode: "append", expectedTurnId: first.turnId,
  }), { code: "unsupported" });
  await adapter.interrupt("", "s-message", first.turnId!);
  held.shift()!.respond({ stopReason: "cancelled" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].prompt[0].text, "second");
  held.shift()!.respond({ stopReason: "end_turn" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
});

test("ACP feedback interrupts then runs before legacy queued messages", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-acp-feedback-"));
  const held: RouteContext[] = [];
  const prompts: Json[] = [];
  const fake = fakeAcpProcess({ routes: {
    "session/new": (_params, ctx) => ctx.respond({ sessionId: "s-feedback" }),
    "session/prompt": (params, ctx) => { prompts.push(params); held.push(ctx); },
  } });
  const adapter = adapterWith(fake);
  await adapter.startAll();
  await adapter.createThread("", { cwd: "/tmp" });
  await adapter.sendTurn("", "s-feedback", "first");
  await adapter.sendTurn("", "s-feedback", "legacy queued");
  const deliveries = new MessageDeliveryQueue({ file: path.join(dir, "messages.json"), agents: new AgentRegistry([adapter]), timer: false });
  await deliveries.load();
  t.after(async () => { deliveries.close(); await adapter.restart(); await rm(dir, { recursive: true, force: true }); });
  await deliveries.enqueue(adapter.id, "s-feedback", "feedback", { text: "feedback" });
  const dispatch = deliveries.tick();
  const deadline = Date.now() + 1000;
  while (!fake.seen.some((msg) => msg.method === "session/cancel") && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.ok(fake.seen.some((msg) => msg.method === "session/cancel"));
  held.shift()!.respond({ stopReason: "cancelled" });
  await dispatch;
  assert.deepEqual(prompts.map((item) => item.prompt[0].text), ["first", "feedback"]);
  held.shift()!.respond({ stopReason: "end_turn" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(prompts.map((item) => item.prompt[0].text), ["first", "feedback", "legacy queued"]);
  held.shift()!.respond({ stopReason: "end_turn" });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
});

test("restart() followed by startAll() waits for the old process to exit", async () => {
  // 第一个进程被 kill 后 40ms 才真正退出；第二个进程正常。
  const first = fakeAcpProcess({
    exitDelayMs: 40,
    routes: { "session/list": (_params, ctx) => ctx.respond({ sessions: [] }) },
  });
  const second = fakeAcpProcess({
    routes: { "session/list": (_params, ctx) => ctx.respond({ sessions: [] }) },
  });
  const children = [first.child, second.child];
  const adapter = new AcpAdapter(SPEC, {
    spawnProcess: (() => children.shift()) as any,
    killProcessTree: () => {},
    requestTimeoutMs: 5_000,
  });
  await adapter.startAll();
  assert.equal(adapter.descriptor().online, true);

  // 重载：不等旧进程退出就拉新进程，旧进程迟到的 exit 不能算到新进程头上。
  adapter.restart();
  await adapter.startAll();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(adapter.descriptor().online, true);
  assert.equal(adapter.descriptor().error, undefined);
  await adapter.restart();
});
