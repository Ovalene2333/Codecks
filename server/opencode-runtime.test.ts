import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createOpenCodeRuntime,
  resolveOpenCodeProtocol,
} from "./opencode-runtime.js";
import { AgentRegistry } from "./agents/registry.js";
import type { AgentAdapter } from "./agents/types.js";

test("OpenCode selects the protocol only from the chosen binary", async () => {
  assert.equal(
    await resolveOpenCodeProtocol("demo", async () => "2.0.32"),
    "v2",
  );
  assert.equal(
    await resolveOpenCodeProtocol("demo", async () => "1.2.3"),
    "v1",
  );
  await assert.rejects(
    resolveOpenCodeProtocol("demo", async () => undefined),
    /无法识别/,
  );
  await assert.rejects(
    resolveOpenCodeProtocol("demo", async () => "0.0.0-dev"),
    /暂不支持/,
  );
});

test("OpenCode runtime switches protocols, forwards only current events and rolls back failed switches", async () => {
  const instances: Array<EventEmitter & AgentAdapter> = [];
  let selected = "demo-v1";
  const runtime = createOpenCodeRuntime({
    bin: selected,
    v1: {},
    v2: {},
    probe: async (bin) => (bin === "demo-v1" ? "1.2.3" : "2.0.32"),
    createAdapter(protocol, bin) {
      const adapter = Object.assign(new EventEmitter(), {
        id: "opencode",
        descriptor: () => ({
          id: "opencode",
          name: "OpenCode",
          online: true,
          available: true,
          capabilities: {},
        }),
        snapshot: () => ({ threads: [], approvals: [] }),
        startAll: async () => {
          if (bin === "demo-broken") throw new Error("demo failure");
        },
        restart() {},
        refreshAll: async () => {},
        busyThreads: () => [],
        listModels: async () => [{ id: protocol }],
      }) as unknown as EventEmitter & AgentAdapter;
      instances.push(adapter);
      return adapter;
    },
  });
  const registry = new AgentRegistry([runtime]);
  await registry.startAll();
  assert.equal(runtime.runtimeProtocol(), "v1");
  const events: unknown[] = [];
  runtime.on("event", (event) => events.push(event));
  const old = instances[0];
  const result = await registry.switchExecutable(
    "opencode",
    async () => {
      selected = "demo-v2";
      runtime.selectExecutable(selected);
    },
    async () => runtime.selectExecutable("demo-v1"),
  );
  assert.equal(result.reloaded, true);
  assert.equal(runtime.runtimeProtocol(), "v2");
  assert.equal((await runtime.listModels?.())?.[0].id, "v2");
  old.emit("event", { stale: true });
  instances.at(-1)!.emit("event", { current: true });
  assert.deepEqual(events, [{ current: true }]);
  const failed = await registry.switchExecutable(
    "opencode",
    async () => runtime.selectExecutable("demo-broken"),
    async () => runtime.selectExecutable(selected),
  );
  assert.equal(failed.reloaded, false);
  assert.match(failed.error || "", /demo failure/);
  assert.equal(runtime.runtimeProtocol(), "v2");
  assert.equal(runtime.descriptor().error, undefined);
});
