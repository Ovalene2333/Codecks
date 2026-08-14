import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyThreadStoreError,
  explainThreadStoreError,
  isMissingRolloutError,
  threadStoreUserMessage,
} from "./thread-store-error.js";

test("classifies Codex 0.147 empty-rollout and legacy unmaterialized errors together", () => {
  assert.equal(
    classifyThreadStoreError(
      new Error(
        "thread fresh is not materialized yet; includeTurns is unavailable before first user message",
      ),
    ),
    "unmaterialized",
  );
  assert.equal(
    classifyThreadStoreError(
      new Error(
        "Failed to read thread: thread-store internal error: failed to read session metadata /home/ovalene/.codex/sessions/2026/08/14/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
      ),
    ),
    "unmaterialized",
  );
  assert.equal(
    classifyThreadStoreError(new Error("no rollout found for thread id fresh")),
    "unmaterialized",
  );
  assert.equal(isMissingRolloutError(new Error("no rollout found")), true);
});

test("classifies missing in-runtime threads separately from empty rollouts", () => {
  assert.equal(
    classifyThreadStoreError(
      new Error("thread not found: 01a00031-3f69-7821-8a43-ce141c5c532b"),
    ),
    "notInRuntime",
  );
  assert.equal(
    classifyThreadStoreError(new Error("invalid thread id: nope")),
    "notInRuntime",
  );
  assert.equal(
    isMissingRolloutError(new Error("thread not found: abc")),
    false,
  );
});

test("classifies writer-lock contention", () => {
  assert.equal(
    classifyThreadStoreError(
      new Error("failed to acquire thread writer coordination lock"),
    ),
    "locked",
  );
  assert.equal(
    classifyThreadStoreError(new Error("thread writer lock is held")),
    "locked",
  );
});

test("leaves unrelated errors alone", () => {
  assert.equal(
    classifyThreadStoreError(new Error("connection lost")),
    "other",
  );
  const original = new Error("connection lost");
  assert.equal(explainThreadStoreError(original), original);
});

test("maps classified errors to Chinese operator messages", () => {
  assert.match(
    threadStoreUserMessage("notInRuntime"),
    /当前 Runtime 里没有这条会话/,
  );
  assert.match(threadStoreUserMessage("locked"), /另一个 Codex 进程写入/);
  assert.match(
    explainThreadStoreError(new Error("thread not found: abc")).message,
    /只留一个实例/,
  );
});
