import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ThreadSummary } from "../types.js";
import type { AcpAgentSpec } from "./acp-adapter.js";
import type { AcpAgentEntry } from "./acp-agents.js";
import { AcpAgentHost } from "./acp-host.js";
import { AgentRegistry } from "./registry.js";
import type { AgentAdapter } from "./types.js";

const capabilities = {
  approvals: true,
  archive: true,
  delete: false,
  fork: false,
  images: false,
  interrupt: true,
  mcp: false,
  models: false,
  review: false,
  sessionSettings: false,
  shell: false,
  skills: false,
};

function thread(agentId: string, id: string): ThreadSummary {
  return {
    agentId,
    id,
    providerId: `${agentId}-current`,
    name: id,
    preview: "",
    cwd: "/tmp",
    model: "default",
    status: "idle",
    updatedAt: 1,
  };
}

class HostAgent extends EventEmitter implements AgentAdapter {
  threads: ThreadSummary[];
  busy = false;
  restarts = 0;
  constructor(
    readonly id: string,
    readonly spec: AcpAgentSpec,
    carried?: ThreadSummary[],
  ) {
    super();
    this.threads = carried ?? [];
  }
  descriptor() {
    return {
      id: this.id,
      name: this.spec.name,
      protocol: "acp" as const,
      available: true,
      online: true,
      capabilities,
    };
  }
  snapshot() {
    return { threads: this.threads, archivedThreads: [], approvals: [] };
  }
  async startAll() {}
  async refreshAll() {}
  busyThreads() {
    return this.busy
      ? [{ ...thread(this.id, "busy"), status: "running" as const }]
      : [];
  }
  restart() {
    this.restarts += 1;
  }
}

const spec = (id: string, extra: Partial<AcpAgentSpec> = {}): AcpAgentSpec => ({
  id,
  name: id.toUpperCase(),
  command: id,
  ...extra,
});

const entry = (
  agentSpec: AcpAgentSpec,
  extra: Partial<AcpAgentEntry> = {},
): AcpAgentEntry => ({
  spec: agentSpec,
  builtin: false,
  defaultEnabled: true,
  ...extra,
});

function setup(
  initial: AcpAgentEntry[],
  overrides: Record<string, boolean> = {},
) {
  const registry = new AgentRegistry();
  let entries = initial;
  const created: HostAgent[] = [];
  const host = new AcpAgentHost({
    registry,
    settings: { enabled: (id) => overrides[id] },
    load: async () => entries,
    create: (agentSpec, carried) => {
      const agent = new HostAgent(agentSpec.id, agentSpec, carried);
      created.push(agent);
      return agent;
    },
  });
  return {
    registry,
    host,
    created,
    setEntries: (next: AcpAgentEntry[]) => {
      entries = next;
    },
  };
}

test("the first sync registers every entry with its resolved enabled state", async () => {
  const { registry, host, created } = setup(
    [
      entry(spec("devin"), { builtin: true }),
      entry(spec("kimi"), {
        builtin: true,
        defaultEnabled: false,
        defaultNote: "未检测到 kimi 命令",
      }),
      entry(spec("goose"), { builtin: true }),
    ],
    // 用户显式选择压过默认：装了也停用 goose，没装也启用 kimi。
    { kimi: true, goose: false },
  );

  const report = await host.sync();

  assert.deepEqual(report.added, ["devin", "kimi", "goose"]);
  assert.equal(created.length, 3);
  assert.equal(registry.isEnabled("devin"), true);
  assert.equal(registry.isEnabled("kimi"), true);
  assert.equal(registry.isEnabled("goose"), false);
  assert.equal(registry.defaultEnabled("kimi"), false);
  assert.equal(registry.defaultEnabled("goose"), true);
  const kimi = registry.list().find((agent) => agent.id === "kimi")!;
  assert.equal(kimi.enabled, true);
});

test("a later sync adds new agents, removes deleted ones and rebuilds changed ones", async () => {
  const setupResult = setup([
    entry(spec("devin")),
    entry(spec("kimi")),
    entry(spec("goose", { args: ["acp"] })),
  ]);
  const { registry, host, created, setEntries } = setupResult;
  await host.sync();
  const devin = registry.get("devin");
  const goose = registry.get("goose") as HostAgent;
  goose.threads = [thread("goose", "g1"), thread("goose", "g2")];

  setEntries([
    entry(spec("devin")),
    // kimi 从配置里删掉；goose 改了启动参数；copilot 是新增的。
    entry(spec("goose", { args: ["acp", "--verbose"] })),
    entry(spec("copilot")),
  ]);
  const report = await host.sync();

  assert.deepEqual(report, {
    added: ["copilot"],
    removed: ["kimi"],
    replaced: ["goose"],
    skippedBusy: [],
  });
  assert.strictEqual(registry.get("devin"), devin);
  assert.throws(() => registry.get("kimi"), /不存在/);
  assert.notStrictEqual(registry.get("goose"), goose);
  assert.equal(goose.restarts, 1);
  // 重建的 adapter 带着旧的会话缓存，没有历史列举能力的 agent 不会丢会话。
  assert.deepEqual(
    (registry.get("goose") as HostAgent).threads.map((item) => item.id),
    ["g1", "g2"],
  );
  assert.deepEqual((registry.get("goose") as HostAgent).spec.args, [
    "acp",
    "--verbose",
  ]);
  assert.ok(registry.list().some((agent) => agent.id === "copilot"));
});

test("an agent with running sessions keeps its old config unless forced", async () => {
  const { registry, host, setEntries } = setup([
    entry(spec("devin")),
    entry(spec("kimi")),
  ]);
  await host.sync();
  (registry.get("devin") as HostAgent).busy = true;
  (registry.get("kimi") as HostAgent).busy = true;
  const devin = registry.get("devin");
  const kimi = registry.get("kimi");

  setEntries([entry(spec("devin", { args: ["v2"] }))]);
  const skipped = await host.sync();
  assert.deepEqual(skipped, {
    added: [],
    removed: [],
    replaced: [],
    skippedBusy: ["devin", "kimi"],
  });
  assert.strictEqual(registry.get("devin"), devin);
  assert.strictEqual(registry.get("kimi"), kimi);

  const forced = await host.sync({ force: true });
  assert.deepEqual(forced.removed, ["kimi"]);
  assert.deepEqual(forced.replaced, ["devin"]);
  assert.notStrictEqual(registry.get("devin"), devin);
});

test("an unchanged agent only has its default policy refreshed", async () => {
  const { registry, host, created, setEntries } = setup([
    entry(spec("kimi"), {
      builtin: true,
      defaultEnabled: false,
      defaultNote: "未检测到 kimi 命令",
    }),
  ]);
  await host.sync();
  const kimi = registry.get("kimi");
  assert.equal(registry.isEnabled("kimi"), false);

  // 之后装上了 kimi：没有显式选择时，当前状态跟着新的默认走。
  setEntries([entry(spec("kimi"), { builtin: true })]);
  const report = await host.sync();

  assert.deepEqual(report, {
    added: [],
    removed: [],
    replaced: [],
    skippedBusy: [],
  });
  assert.strictEqual(registry.get("kimi"), kimi);
  assert.equal(created.length, 1);
  assert.equal(registry.isEnabled("kimi"), true);
});

test("overlapping syncs run one after another", async () => {
  const { registry, host, setEntries } = setup([entry(spec("devin"))]);
  const first = host.sync();
  setEntries([entry(spec("devin")), entry(spec("kimi"))]);
  const second = host.sync();

  const [a, b] = await Promise.all([first, second]);

  // 先后两次都成功，没有因为重复注册而抛错。
  assert.deepEqual(a.added.concat(b.added).sort(), ["devin", "kimi"]);
  assert.deepEqual(
    registry.list().map((agent) => agent.id),
    ["devin", "kimi"],
  );
});
