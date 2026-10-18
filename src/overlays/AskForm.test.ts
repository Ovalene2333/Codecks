import assert from "node:assert/strict";
import test from "node:test";
import { resolveReturnMode } from "./AskForm";

test("codex-like targets default to steer until the user picks a mode", () => {
  assert.equal(resolveReturnMode("queue", false, true), "steer");
  assert.equal(resolveReturnMode("interrupt", false, true), "steer");
  assert.equal(resolveReturnMode("steer", false, true), "steer");
  assert.equal(resolveReturnMode("queue", true, true), "queue");
  assert.equal(resolveReturnMode("interrupt", true, true), "interrupt");
});

test("switching to a target without steer falls back to queue", () => {
  assert.equal(resolveReturnMode("steer", false, false), "queue");
  assert.equal(resolveReturnMode("steer", true, false), "queue");
  assert.equal(resolveReturnMode("queue", true, false), "queue");
  assert.equal(resolveReturnMode("queue", false, undefined), "queue");
});
