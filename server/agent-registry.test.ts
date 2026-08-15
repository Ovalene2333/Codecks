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
      approvals: [],
    };
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
