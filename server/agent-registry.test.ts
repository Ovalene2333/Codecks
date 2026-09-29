import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { AgentRegistry } from "./agents/registry.js";
import type {
  AgentAdapter,
  AgentApproval,
  AgentCapabilities,
  AgentDescriptor,
  AgentId,
} from "./agents/types.js";
import type { ThreadSummary } from "./types.js";

const capabilities: AgentCapabilities = {
  approvals: true,
  archive: false,
  delete: false,
  fork: false,
  images: false,
  interrupt: true,
  mcp: false,
  models: true,
  review: false,
  sessionSettings: false,
  shell: false,
  skills: false,
};

class FakeAgent extends EventEmitter implements AgentAdapter {
  starts = 0;
  refreshes = 0;
  stops = 0;
  lastRead?: { providerId: string; threadId: string };

  constructor(readonly id: AgentId) {
    super();
  }

  descriptor() {
    return {
      id: this.id,
      name: this.id,
      available: true,
      online: true,
      capabilities,
    };
  }

  snapshot() {
    return {
      providers: this.id === "codex" ? [{ id: "provider" }] : [],
      runtime: this.id === "codex" ? { online: true } : undefined,
      threads: [
        {
          agentId: this.id,
          id: `${this.id}-thread`,
          providerId: `${this.id}-profile`,
          name: this.id,
          preview: "",
          cwd: "/tmp",
          model: "default",
          status: "idle" as const,
          updatedAt: 1,
        },
      ],
      archivedThreads:
        this.id === "codex"
          ? [
              {
                agentId: this.id,
                id: "codex-archived",
                providerId: "codex-profile",
                name: "archived",
                preview: "",
                cwd: "/tmp",
                model: "default",
                status: "idle" as const,
                archived: true,
                updatedAt: 1,
              },
            ]
          : [],
      approvals: [],
    };
  }

  publicProfiles() {
    return [
      {
        id: `${this.id}-profile`,
        agentId: this.id,
        name: `${this.id} profile`,
      },
    ];
  }

  async startAll() {
    this.starts += 1;
  }

  async refreshAll() {
    this.refreshes += 1;
  }

  busyThreads() {
    return [];
  }

  async readThread(providerId: string, threadId: string) {
    this.lastRead = { providerId, threadId };
    return { id: threadId };
  }

  archived: string[] = [];
  unarchived: string[] = [];

  async archiveThread(providerId: string, threadId: string) {
    this.archived.push(`${providerId}:${threadId}`);
    return { id: threadId };
  }

  async unarchiveThread(providerId: string, threadId: string) {
    this.unarchived.push(`${providerId}:${threadId}`);
    return { id: threadId };
  }

  restart() {
    this.stops += 1;
  }
}

test("registry merges agent snapshots while preserving the primary runtime", () => {
  const codex = new FakeAgent("codex");
  const claude = new FakeAgent("claude");
  const registry = new AgentRegistry([codex, claude]);

  const snapshot = registry.snapshot();
  assert.deepEqual(
    snapshot.threads.map((thread) => thread.agentId),
    ["codex", "claude"],
  );
  assert.deepEqual(snapshot.providers, [{ id: "provider" }]);
  assert.deepEqual(snapshot.runtime, { online: true });
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.id),
    ["codex", "claude"],
  );
  assert.deepEqual(
    snapshot.agentProfiles.map((profile) => profile.id),
    ["codex-profile", "claude-profile"],
  );
});

test("registry forwards events and owns adapter lifecycle", async () => {
  const codex = new FakeAgent("codex");
  const claude = new FakeAgent("claude");
  const registry = new AgentRegistry([codex, claude]);
  const events: unknown[] = [];
  registry.on("event", (event) => events.push(event));

  claude.emit("event", { type: "thread.updated" });
  await registry.startAll();
  await registry.refreshAll();
  registry.stopAll();

  assert.deepEqual(events, [{ type: "thread.updated" }]);
  assert.deepEqual(
    [codex.starts, claude.starts, codex.refreshes, claude.refreshes],
    [1, 1, 1, 1],
  );
  assert.deepEqual([codex.stops, claude.stops], [1, 1]);
});

test("one failing adapter does not prevent other adapters from starting", async () => {
  const codex = new FakeAgent("codex");
  const claude = new FakeAgent("claude");
  claude.startAll = async () => {
    claude.starts += 1;
    throw new Error("Claude unavailable");
  };
  const registry = new AgentRegistry([codex, claude]);

  await registry.startAll();

  assert.equal(codex.starts, 1);
  assert.equal(claude.starts, 1);
});

test("registry reports startup failure when every adapter fails", async () => {
  const codex = new FakeAgent("codex");
  const claude = new FakeAgent("claude");
  codex.startAll = claude.startAll = async () => {
    throw new Error("unavailable");
  };
  const registry = new AgentRegistry([codex, claude]);

  await assert.rejects(registry.startAll(), /所有 Agent 均启动失败/);
});

test("registry reads archived sessions through the generic Agent route", async () => {
  const codex = new FakeAgent("codex");
  const registry = new AgentRegistry([codex]);

  assert.deepEqual(await registry.readThread("codex", "codex-archived"), {
    id: "codex-archived",
  });
  assert.deepEqual(codex.lastRead, {
    providerId: "codex-profile",
    threadId: "codex-archived",
  });
});

test("registry dispatches archive calls and rejects unsupported agents", async () => {
  const codex = new FakeAgent("codex");
  const registry = new AgentRegistry([codex]);

  await registry.archiveThread("codex", "codex-thread");
  await registry.unarchiveThread("codex", "codex-thread");
  assert.deepEqual(codex.archived, ["codex-profile:codex-thread"]);
  assert.deepEqual(codex.unarchived, ["codex-profile:codex-thread"]);

  const noArchive: any = new FakeAgent("claude");
  // 方法在原型上：实例赋值遮蔽，模拟未实现归档的 adapter。
  noArchive.archiveThread = undefined;
  noArchive.unarchiveThread = undefined;
  const bare = new AgentRegistry([noArchive]);
  await assert.rejects(
    bare.archiveThread("claude", "claude-thread"),
    /不支持此操作/,
  );
});

// ------------------------------------------------- 备选 agent（fallbackFor）

/** 可编排状态与会话的 adapter，用来模拟主 agent 与它的 ACP 备选。 */
class ScriptedAgent extends FakeAgent {
  online = true;
  starting = false;
  historyStatus: AgentDescriptor["historyStatus"] = "ready";
  fallbackFor?: AgentId;
  threads: ThreadSummary[] = [];
  archivedThreads: ThreadSummary[] = [];
  approvals: AgentApproval[] = [];

  descriptor() {
    return {
      ...super.descriptor(),
      online: this.online,
      starting: this.starting,
      historyStatus: this.historyStatus,
      fallbackFor: this.fallbackFor,
    };
  }

  snapshot() {
    return {
      threads: this.threads,
      archivedThreads: this.archivedThreads,
      approvals: this.approvals,
    };
  }
}

function summary(
  agentId: AgentId,
  id: string,
  extra: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    agentId,
    id,
    providerId: `${agentId}-current`,
    name: id,
    preview: "",
    cwd: "/tmp",
    model: "default",
    status: "idle",
    controlMode: "history",
    updatedAt: 1,
    ...extra,
  };
}

/** claude 原生 + claude-acp 备选：a/b 是共享的会话，shell 是 ACP 侧的空壳。 */
function claudePair() {
  const claude = new ScriptedAgent("claude");
  const acp = new ScriptedAgent("claude-acp");
  acp.fallbackFor = "claude";
  claude.threads = [summary("claude", "a"), summary("claude", "b")];
  acp.threads = [
    summary("claude-acp", "a"),
    summary("claude-acp", "b"),
    summary("claude-acp", "shell"),
  ];
  acp.archivedThreads = [summary("claude-acp", "old", { archived: true })];
  return { claude, acp, registry: new AgentRegistry([claude, acp]) };
}

const keys = (threads: ThreadSummary[]) =>
  threads.map((thread) => `${thread.agentId}:${thread.id}`);

test("fallback agent history is hidden while the primary agent is usable", () => {
  const { registry } = claudePair();

  const snapshot = registry.snapshot();
  assert.deepEqual(keys(snapshot.threads), ["claude:a", "claude:b"]);
  assert.deepEqual(keys(snapshot.archivedThreads), []);
  // 描述符仍完整列出，选择器和设置页照常展示备选 agent；standby 告诉
  // 客户端它正在待命，本地缓存的旧副本也要丢掉。
  assert.deepEqual(
    snapshot.agents.map((agent) => [
      agent.id,
      agent.fallbackFor,
      agent.standby,
    ]),
    [
      ["claude", undefined, undefined],
      ["claude-acp", "claude", true],
    ],
  );
  assert.deepEqual(registry.list(), snapshot.agents);
});

test("fallback agent takes over when the primary agent is unusable", () => {
  const { claude, registry } = claudePair();
  const everything = [
    "claude:a",
    "claude:b",
    "claude-acp:a",
    "claude-acp:b",
    "claude-acp:shell",
  ];

  const standby = () =>
    registry.list().find((agent) => agent.id === "claude-acp")?.standby;

  claude.online = false;
  assert.deepEqual(keys(registry.snapshot().threads), everything);
  assert.deepEqual(keys(registry.snapshot().archivedThreads), [
    "claude-acp:old",
  ]);
  assert.equal(standby(), undefined);

  // 上线了，但历史读取失败：读不到会话的主 agent 不算可用。
  claude.online = true;
  claude.historyStatus = "error";
  assert.deepEqual(keys(registry.snapshot().threads), everything);
  assert.equal(standby(), undefined);

  // 正在启动不闪烁：启动期间就按可用处理，备选会话不先冒出来再消失。
  claude.online = false;
  claude.historyStatus = "loading";
  claude.starting = true;
  assert.deepEqual(keys(registry.snapshot().threads), ["claude:a", "claude:b"]);
  assert.equal(standby(), true);
});

test("a fallback session the deck has taken over stays and displaces the primary copy", () => {
  const { claude, acp, registry } = claudePair();
  // ACP 里 a 是本进程新建/接管的；原生那边只是从同一份磁盘会话读出的历史副本。
  acp.threads[0] = summary("claude-acp", "a", { controlMode: "managed" });
  // b 正在 ACP 里跑：即使没有 managed 标记，有活动就必须可见。
  acp.threads[1] = summary("claude-acp", "b", { status: "running" });

  assert.deepEqual(keys(registry.snapshot().threads), [
    "claude-acp:a",
    "claude-acp:b",
  ]);

  // 原生副本自己也被接管时不让位：宁可重复也不隐藏活动会话。
  claude.threads[0] = summary("claude", "a", { controlMode: "managed" });
  assert.deepEqual(keys(registry.snapshot().threads), [
    "claude:a",
    "claude-acp:a",
    "claude-acp:b",
  ]);
});

test("fallbackFor without a matching primary agent hides nothing", () => {
  const acp = new ScriptedAgent("claude-acp");
  acp.fallbackFor = "claude";
  acp.threads = [summary("claude-acp", "a")];
  const dangling = new AgentRegistry([acp]);
  assert.deepEqual(keys(dangling.snapshot().threads), ["claude-acp:a"]);

  const selfish = new ScriptedAgent("claude-acp");
  selfish.fallbackFor = "claude-acp";
  selfish.threads = [summary("claude-acp", "a")];
  assert.deepEqual(keys(new AgentRegistry([selfish]).snapshot().threads), [
    "claude-acp:a",
  ]);
});

test("hidden fallback sessions cannot leak back through thread.updated events", () => {
  const { claude, acp, registry } = claudePair();
  const events: { type: string; data?: unknown }[] = [];
  registry.on("event", (event) => events.push(event));

  // 空闲历史：已被快照过滤，事件也不得转发。
  acp.emit("event", { type: "thread.updated", data: acp.threads[2] });
  assert.deepEqual(events, []);

  // 被接管/有活动的会话，以及非 thread.updated 事件照常转发。
  const live = summary("claude-acp", "a", { controlMode: "managed" });
  const running = summary("claude-acp", "b", { status: "running" });
  acp.emit("event", { type: "thread.updated", data: live });
  acp.emit("event", { type: "thread.updated", data: running });
  acp.emit("event", { type: "snapshot", data: {} });
  acp.emit("event", { type: "agent.event", data: { agentId: "claude-acp" } });
  assert.deepEqual(
    events.map((event) => event.type),
    ["thread.updated", "thread.updated", "snapshot", "agent.event"],
  );

  // 主 agent 自己的事件不受影响。
  claude.emit("event", { type: "thread.updated", data: claude.threads[0] });
  assert.equal(events.length, 5);

  // 主 agent 不可用时，备选的空闲会话事件恢复转发。
  events.length = 0;
  claude.online = false;
  acp.emit("event", { type: "thread.updated", data: acp.threads[2] });
  assert.equal(events.length, 1);
});

test("hidden fallback sessions stay addressable through the generic routes", async () => {
  const { registry } = claudePair();

  assert.deepEqual(await registry.readThread("claude-acp", "shell"), {
    id: "shell",
  });
});

// ------------------------------------------------- 启用 / 停用 / 重载

/** 记录生命周期调用顺序的 adapter；可编排「忙」和「启动失败」。 */
class LifecycleAgent extends ScriptedAgent {
  log: string[] = [];
  busy: ThreadSummary[] = [];
  failStart?: string;
  startDelay = 0;
  active = 0;
  maxActive = 0;

  async startAll() {
    this.log.push("start");
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.startDelay)
        await new Promise((resolve) => setTimeout(resolve, this.startDelay));
      if (this.failStart) throw new Error(this.failStart);
    } finally {
      this.active -= 1;
    }
  }

  restart() {
    this.log.push("restart");
  }

  busyThreads() {
    return this.busy;
  }
}

const KIMI_OFF = {
  enabled: false,
  defaultEnabled: false,
  defaultNote: "未检测到 kimi 命令",
};

function kimiSetup(registration: Parameters<AgentRegistry["register"]>[1]) {
  const codex = new FakeAgent("codex");
  const kimi = new LifecycleAgent("kimi");
  kimi.threads = [summary("kimi", "k1")];
  kimi.archivedThreads = [summary("kimi", "k0", { archived: true })];
  kimi.approvals = [
    { id: "ap", agentId: "kimi", request: { method: "x" } } as AgentApproval,
  ];
  const registry = new AgentRegistry();
  registry.register(codex, { toggleable: false });
  registry.register(kimi, registration);
  return { codex, kimi, registry };
}

test("disabled agents are not started and contribute nothing to the snapshot", async () => {
  const { codex, kimi, registry } = kimiSetup(KIMI_OFF);
  // 停用的 agent 停机后可能还留着过期的错误和历史状态，描述符里不能再报。
  kimi.online = true;
  kimi.historyStatus = "error";

  await registry.startAll();
  await registry.refreshAll();
  assert.deepEqual(kimi.log, []);
  assert.equal(codex.starts, 1);
  assert.equal(codex.refreshes, 1);

  const snapshot = registry.snapshot();
  assert.deepEqual(keys(snapshot.threads), ["codex:codex-thread"]);
  assert.deepEqual(keys(snapshot.archivedThreads), ["codex:codex-archived"]);
  assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(
    snapshot.agentProfiles.map((profile) => profile.id),
    ["codex-profile"],
  );

  const kimiDescriptor = snapshot.agents.find((agent) => agent.id === "kimi")!;
  assert.equal(kimiDescriptor.enabled, false);
  assert.equal(kimiDescriptor.toggleable, true);
  assert.equal(kimiDescriptor.disabledReason, "default");
  assert.equal(kimiDescriptor.defaultNote, "未检测到 kimi 命令");
  assert.equal(kimiDescriptor.online, false);
  assert.equal(kimiDescriptor.starting, false);
  assert.equal(kimiDescriptor.historyStatus, undefined);
  const codexDescriptor = snapshot.agents.find(
    (agent) => agent.id === "codex",
  )!;
  assert.equal(codexDescriptor.enabled, true);
  assert.equal(codexDescriptor.toggleable, false);
  assert.equal(codexDescriptor.disabledReason, undefined);
  assert.equal(registry.isEnabled("kimi"), false);
  assert.equal(registry.defaultEnabled("kimi"), false);
});

test("a user-disabled agent reports the user as the reason, not the default", () => {
  const { registry } = kimiSetup({ enabled: false });
  const kimi = registry.list().find((agent) => agent.id === "kimi")!;
  assert.equal(kimi.disabledReason, "user");
  assert.equal(kimi.defaultNote, undefined);
});

test("disabled agents keep their sessions in the on-disk cache", () => {
  const { registry } = kimiSetup(KIMI_OFF);

  const cache = registry.cacheSnapshot();
  assert.deepEqual(keys(cache.threads), ["codex:codex-thread", "kimi:k1"]);
  assert.deepEqual(keys(cache.archivedThreads), [
    "codex:codex-archived",
    "kimi:k0",
  ]);
});

test("operations on a disabled agent are refused and its events are dropped", async () => {
  const { kimi, registry } = kimiSetup(KIMI_OFF);
  const events: unknown[] = [];
  registry.on("event", (event) => events.push(event));

  await assert.rejects(registry.readThread("kimi", "k1"), /kimi 未启用/);
  await assert.rejects(
    registry.createThread("kimi", { cwd: "/tmp" }),
    /未启用/,
  );
  assert.deepEqual(registry.profiles("kimi"), []);

  kimi.emit("event", { type: "thread.updated", data: kimi.threads[0] });
  kimi.emit("event", { type: "agent.status", data: {} });
  assert.deepEqual(events, []);
});

test("enabling starts the agent, announces the change and survives a failed start", async () => {
  const { kimi, registry } = kimiSetup(KIMI_OFF);
  const events: { type: string }[] = [];
  registry.on("event", (event) => events.push(event));

  assert.deepEqual(await registry.setEnabled("kimi", true), {
    applied: true,
    changed: true,
    busyCount: 0,
  });
  assert.deepEqual(kimi.log, ["start"]);
  assert.equal(registry.isEnabled("kimi"), true);
  assert.ok(events.some((event) => event.type === "snapshot"));
  assert.deepEqual(keys(registry.snapshot().threads), [
    "codex:codex-thread",
    "kimi:k1",
  ]);

  // 启动失败是 agent 自己的状态，启用这个操作本身仍然算成功。
  const failing = kimiSetup(KIMI_OFF);
  failing.kimi.failStart = "spawn kimi ENOENT";
  const result = await failing.registry.setEnabled("kimi", true);
  assert.equal(result.applied, true);
  assert.equal(failing.registry.isEnabled("kimi"), true);
});

test("disabling stops the agent and hides its sessions right away", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  const events: { type: string }[] = [];
  registry.on("event", (event) => events.push(event));

  assert.deepEqual(await registry.setEnabled("kimi", false), {
    applied: true,
    changed: true,
    busyCount: 0,
  });
  assert.deepEqual(kimi.log, ["restart"]);
  assert.equal(registry.isEnabled("kimi"), false);
  assert.deepEqual(keys(registry.snapshot().threads), ["codex:codex-thread"]);
  assert.ok(events.some((event) => event.type === "snapshot"));

  // 状态没变化时什么都不做。
  kimi.log.length = 0;
  assert.deepEqual(await registry.setEnabled("kimi", false), {
    applied: true,
    changed: false,
    busyCount: 0,
  });
  assert.deepEqual(kimi.log, []);
});

test("disabling a busy agent needs confirmation; force interrupts it", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  kimi.busy = [summary("kimi", "k1", { status: "running" })];

  assert.deepEqual(await registry.setEnabled("kimi", false), {
    applied: false,
    changed: false,
    busyCount: 1,
  });
  assert.equal(registry.isEnabled("kimi"), true);
  assert.deepEqual(kimi.log, []);

  assert.deepEqual(await registry.setEnabled("kimi", false, { force: true }), {
    applied: true,
    changed: true,
    busyCount: 1,
  });
  assert.equal(registry.isEnabled("kimi"), false);
  assert.deepEqual(kimi.log, ["restart"]);
});

test("the core agent cannot be disabled", async () => {
  const { codex, registry } = kimiSetup({ enabled: true });
  await assert.rejects(registry.setEnabled("codex", false), /核心 Agent/);
  assert.equal(registry.isEnabled("codex"), true);
  assert.equal(codex.stops, 0);
});

test("reload restarts the agent's backend and starts it again, in that order", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  const events: { type: string }[] = [];
  registry.on("event", (event) => events.push(event));

  assert.deepEqual(await registry.reload("kimi"), {
    id: "kimi",
    reloaded: true,
    busyCount: 0,
  });
  assert.deepEqual(kimi.log, ["restart", "start"]);
  assert.ok(events.some((event) => event.type === "snapshot"));
});

test("an adapter can provide a reload that does not stop its backend", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  kimi.reload = async () => {
    kimi.log.push("reload");
  };

  assert.equal((await registry.reload("kimi")).reloaded, true);
  // Claude 这类长连接会话的 adapter：重载不能走 restart()，否则会断连接。
  assert.deepEqual(kimi.log, ["reload"]);
});

test("reload skips a busy agent unless forced, and reports how many sessions", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  kimi.busy = [
    summary("kimi", "k1", { status: "running" }),
    summary("kimi", "k2", { status: "waiting" }),
  ];

  assert.deepEqual(await registry.reload("kimi"), {
    id: "kimi",
    reloaded: false,
    busyCount: 2,
  });
  assert.deepEqual(kimi.log, []);

  assert.deepEqual(await registry.reload("kimi", { force: true }), {
    id: "kimi",
    reloaded: true,
    busyCount: 2,
  });
  assert.deepEqual(kimi.log, ["restart", "start"]);
});

test("reload refuses a disabled agent and captures start failures instead of throwing", async () => {
  const off = kimiSetup(KIMI_OFF);
  await assert.rejects(off.registry.reload("kimi"), /kimi 未启用/);

  const failing = kimiSetup({ enabled: true });
  failing.kimi.failStart = "spawn kimi ENOENT";
  const result = await failing.registry.reload("kimi");
  assert.equal(result.reloaded, false);
  assert.match(result.error || "", /ENOENT/);
});

test("lifecycle operations on one agent never overlap", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  kimi.startDelay = 20;

  await Promise.all([
    registry.reload("kimi"),
    registry.reload("kimi"),
    registry.reload("kimi"),
  ]);

  assert.equal(kimi.maxActive, 1);
  assert.deepEqual(kimi.log, [
    "restart",
    "start",
    "restart",
    "start",
    "restart",
    "start",
  ]);
});

test("reloadAll reloads the enabled agents and only makes sure disabled ones are stopped", async () => {
  const { codex, kimi, registry } = kimiSetup({ enabled: true });
  const goose = new LifecycleAgent("goose");
  registry.register(goose, { enabled: false, defaultEnabled: false });
  const busy = new LifecycleAgent("busy");
  busy.busy = [summary("busy", "b1", { status: "running" })];
  registry.register(busy);

  const results = await registry.reloadAll();

  assert.deepEqual(
    results.map((item) => [item.id, item.reloaded, item.busyCount]),
    [
      ["codex", true, 0],
      ["kimi", true, 0],
      ["busy", false, 1],
    ],
  );
  assert.equal(codex.stops, 1);
  assert.equal(codex.starts, 1);
  assert.deepEqual(kimi.log, ["restart", "start"]);
  // 停用的：确保停着，绝不启动。
  assert.deepEqual(goose.log, ["restart"]);
  assert.deepEqual(busy.log, []);
});

test("configure changes the policy and state without touching the backend", () => {
  const { kimi, registry } = kimiSetup(KIMI_OFF);

  // 例如刚装上 kimi：默认策略变成「加载」，当前状态跟着切过去，但不启停。
  registry.configure("kimi", { enabled: true, defaultEnabled: true });
  assert.equal(registry.isEnabled("kimi"), true);
  assert.equal(registry.defaultEnabled("kimi"), true);
  assert.equal(
    registry.list().find((agent) => agent.id === "kimi")?.disabledReason,
    undefined,
  );
  assert.deepEqual(kimi.log, []);

  // 只改策略说明时不改当前启用状态。
  registry.configure("kimi", { defaultNote: "另一个原因" });
  assert.equal(registry.isEnabled("kimi"), true);
});

test("unregister stops the agent, removes it and detaches its events", async () => {
  const { kimi, registry } = kimiSetup({ enabled: true });
  const events: unknown[] = [];
  registry.on("event", (event) => events.push(event));

  await registry.unregister("kimi");

  assert.deepEqual(kimi.log, ["restart"]);
  assert.throws(() => registry.get("kimi"), /不存在/);
  assert.deepEqual(
    registry.list().map((agent) => agent.id),
    ["codex"],
  );
  events.length = 0;
  kimi.emit("event", { type: "thread.updated", data: kimi.threads[0] });
  assert.deepEqual(events, []);

  // 同一个 id 可以重新注册（配置变更后用新描述符重建）。
  const rebuilt = new LifecycleAgent("kimi");
  registry.register(rebuilt);
  assert.equal(registry.isEnabled("kimi"), true);
});

test("disabling the primary agent lets its fallback take over", async () => {
  const claude = new LifecycleAgent("claude");
  const acp = new ScriptedAgent("claude-acp");
  acp.fallbackFor = "claude";
  claude.threads = [summary("claude", "a")];
  acp.threads = [summary("claude-acp", "a"), summary("claude-acp", "shell")];
  const registry = new AgentRegistry([claude, acp]);

  assert.deepEqual(keys(registry.snapshot().threads), ["claude:a"]);
  await registry.setEnabled("claude", false);
  assert.deepEqual(keys(registry.snapshot().threads), [
    "claude-acp:a",
    "claude-acp:shell",
  ]);
  assert.equal(
    registry.list().find((agent) => agent.id === "claude-acp")?.standby,
    undefined,
  );
});
