import assert from "node:assert/strict";
import test from "node:test";
import { resolveReturnMode } from "./AskForm";

test("steer-capable sources default to steer until the user picks a mode", () => {
  assert.equal(resolveReturnMode("queue", false, true), "steer");
  assert.equal(resolveReturnMode("interrupt", false, true), "steer");
  assert.equal(resolveReturnMode("steer", false, true), "steer");
  assert.equal(resolveReturnMode("queue", true, true), "queue");
  assert.equal(resolveReturnMode("interrupt", true, true), "interrupt");
});

test("sources without steer fall back to queue", () => {
  assert.equal(resolveReturnMode("steer", false, false), "queue");
  assert.equal(resolveReturnMode("steer", true, false), "queue");
  assert.equal(resolveReturnMode("queue", true, false), "queue");
  assert.equal(resolveReturnMode("queue", false, undefined), "queue");
});
