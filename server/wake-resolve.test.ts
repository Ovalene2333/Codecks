import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestorPids,
  bindingConflict,
  resolveWakeSession,
  within,
} from "./wake-resolve.js";
import type { ThreadSummary } from "./types.js";

const thread = (
  agentId: string,
  id: string,
  cwd: string,
  status: ThreadSummary["status"] = "idle",
): ThreadSummary => ({
  agentId,
  id,
  providerId: "p",
  name: `${agentId}-${id}`,
  preview: "",
  cwd,
  model: "m",
  status,
  updatedAt: 0,
});

const threads = [
  thread("codex", "c1", "/home/u/RL", "running"),
  thread("codex", "c2", "/home/u/RL"),
  thread("devin", "d1", "/home/u/RL", "running"),
  thread("devin", "d2", "/home/u/RL/sub", "running"),
  thread("opencode", "o1", "/home/u/RL", "running"),
  thread("opencode", "o2", "/home/u/RL", "running"),
  thread("claude", "k1", "/home/u/RL", "running"),
];
const runtimePids = [
  { agentId: "codex", pid: 100 },
  { agentId: "devin", pid: 200 },
  { agentId: "opencode", pid: 300 },
];
const context = { threads, runtimePids };

test("agent-provided session variables win", () => {
  const byDeck = resolveWakeSession({ session: "claude:k1", ancestors: [9, 8] }, context);
  assert.equal(byDeck.ok && byDeck.threadId, "k1");
  // Codex 的 CODEX_THREAD_ID 指向一个不在跑的会话也认：变量是确定性的。
  const byCodex = resolveWakeSession({ codexThread: "c2", ancestors: [9, 100] }, context);
  assert.equal(byCodex.ok && byCodex.threadId, "c2");
  assert.equal(byCodex.ok && byCodex.via, "CODEX_THREAD_ID");
});

test("inherited variables are ignored when the process tree says otherwise", () => {
  // Deck 若从某个 Codex 会话里启动，OpenCode 的 shell 也会带着 CODEX_THREAD_ID。
  const result = resolveWakeSession(
    { codexThread: "c1", ancestors: [9, 300], cwd: "/home/u/RL" },
    { threads: threads.filter((t) => t.id !== "o2"), runtimePids },
  );
  assert.equal(result.ok && `${result.agentId}:${result.threadId}`, "opencode:o1");
});

test("process tree picks the only running session of that agent", () => {
  const result = resolveWakeSession({ ancestors: [9, 50, 100, 1] }, context);
  assert.equal(result.ok && result.threadId, "c1");
});

test("several running sessions are narrowed by the deepest cwd", () => {
  const result = resolveWakeSession({ ancestors: [9, 200], cwd: "/home/u/RL/sub/x" }, context);
  assert.equal(result.ok && result.threadId, "d2");
});

test("ambiguity and missing evidence fail with candidates instead of guessing", () => {
  const ambiguous = resolveWakeSession({ ancestors: [9, 300], cwd: "/home/u/RL" }, context);
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(
    !ambiguous.ok && ambiguous.candidates.map((t) => t.id),
    ["o1", "o2"],
  );
  // 不是 Deck 托管的进程（例如用户自己在终端里跑），即使只有一个会话在跑也不猜。
  const unknown = resolveWakeSession({ ancestors: [9, 1] }, { threads: [threads[0]], runtimePids });
  assert.equal(unknown.ok, false);
  const unknownSession = resolveWakeSession({ session: "claude:nope", ancestors: [] }, context);
  assert.equal(unknownSession.ok, false);
});

test("explicit codes belonging to another session are flagged", () => {
  const resolved = resolveWakeSession({ ancestors: [9, 100] }, context);
  assert.equal(bindingConflict({ agentId: "codex", threadId: "c1" }, resolved), undefined);
  const other = bindingConflict({ agentId: "devin", threadId: "d1" }, resolved);
  assert.equal(other && !Array.isArray(other) && other.id, "c1");
  // 判定失败但进程树明确是 opencode：借用 codex 会话的代号也算冲突。
  const ambiguous = resolveWakeSession({ ancestors: [9, 300] }, context);
  assert.deepEqual(bindingConflict({ agentId: "codex", threadId: "c2" }, ambiguous), ["opencode"]);
  assert.equal(bindingConflict({ agentId: "opencode", threadId: "o2" }, ambiguous), undefined);
  // 毫无线索时不拦（脚本由用户在终端手动运行）。
  const none = resolveWakeSession({ ancestors: [] }, context);
  assert.equal(bindingConflict({ agentId: "codex", threadId: "c2" }, none), undefined);
});

test("within compares path segments, not string prefixes", () => {
  assert.equal(within("/home/u/RL", "/home/u/RL/"), true);
  assert.equal(within("/home/u/RL/a", "/home/u/RL"), true);
  assert.equal(within("/home/u/RL2", "/home/u/RL"), false);
  assert.equal(within("/x", "/"), true);
});

test("ancestor chain of this process reaches its parent", { skip: process.platform === "win32" }, async () => {
  const chain = await ancestorPids(process.pid);
  assert.equal(chain[0], process.pid);
  assert.equal(chain[1], process.ppid);
});
