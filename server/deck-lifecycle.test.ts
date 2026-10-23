import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertDeckLifecycleOwner, waitForDeckStop } from "./deck-lifecycle.js";
import type { AgentRegistry } from "./agents/registry.js";
import type { AskRecord } from "./ask-service.js";

const item = { sourceAgentId: "demo", sourceThreadId: "parent", targetAgentId: "demo", targetThreadId: "child" } as AskRecord;

test("agent deletion cannot bypass ownership or delete itself", () => {
  assert.doesNotThrow(() => assertDeckLifecycleOwner(item, { kind: "agent", agentId: "demo", threadId: "parent" }, false));
  for (const threadId of ["child", "other"])
    assert.throws(() => assertDeckLifecycleOwner(item, { kind: "agent", agentId: "demo", threadId }, false), { code: "FORBIDDEN" });
  assert.doesNotThrow(() => assertDeckLifecycleOwner(item, { kind: "agent", agentId: "demo", threadId: "child" }));
});

test("deck deletion never forwards force to worktree cleanup", async () => {
  const source = await readFile("server/index.ts", "utf8");
  assert.match(source, /worktrees\.remove\(item\.targetThreadId, \{ force: false \}\)/);
  assert.doesNotMatch(source, /worktrees\.remove\(item\.targetThreadId, \{ force: input\.force \}\)/);
});

test("an externally removed native session counts as already deleted, not indefinitely busy", async () => {
  const agents = { messageState: () => { throw new Error("会话不存在"); } } as unknown as AgentRegistry;
  assert.equal(await waitForDeckStop(agents, "demo", "gone", 1), false);
});
