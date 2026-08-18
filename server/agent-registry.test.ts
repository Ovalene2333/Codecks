import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { AgentRegistry } from "./agents/registry.js";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentId,
} from "./agents/types.js";

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
