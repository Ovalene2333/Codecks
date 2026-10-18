import assert from "node:assert/strict";
import test from "node:test";
import { messageControls } from "./message-controls";
import type { AgentCapabilities, ThreadSummary } from "../types";

const thread = { status: "waiting", activeTurnId: "turn" } as ThreadSummary;
const caps = (busyBehavior: "steer" | "queue" | "reject" | "unknown") =>
  ({ messages: { busyBehavior, interruptScope: "session" } }) as AgentCapabilities;

test("ordinary conversation labels distinguish steering, queueing, rejection and unknown backend behavior", () => {
  assert.equal(messageControls(thread, caps("steer")).label, "即时反馈");
  assert.equal(messageControls(thread, caps("queue")).label, "排队");
  assert.equal(messageControls(thread, caps("reject")).blocked, true);
  assert.equal(messageControls(thread, caps("unknown")).label, "发送消息");
  assert.equal(messageControls(thread).label, "发送消息");
  assert.equal(messageControls({ ...thread, activeTurnId: undefined }, caps("reject")).blocked, true);
  assert.equal(messageControls({ ...thread, status: "idle", activeTurnId: undefined }, caps("reject")).blocked, false);
});

test("user-selected modes are available on all declared transports, including busy Claude", () => {
  for (const behavior of ["steer", "reject", "queue", "unknown"] as const) {
    const capabilities = caps(behavior);
    capabilities.messages!.deliveryModes = ["queue", "feedback"];
    assert.equal(messageControls(thread, capabilities, "queue").blocked, false);
    assert.equal(messageControls(thread, capabilities, "queue").label, "排队");
    const immediate = messageControls(thread, capabilities, "feedback");
    assert.equal(immediate.blocked, false);
    assert.equal(immediate.label, "即时反馈");
    assert.equal(immediate.help.includes("先停止"), behavior !== "steer");
  }
});

test("append mode steers into the running turn without interrupting", () => {
  const running = { status: "running", activeTurnId: "turn" } as ThreadSummary;
  const steer = messageControls(running, caps("steer"), "append");
  assert.equal(steer.blocked, false);
  assert.equal(steer.label, "即时追加");
  const reject = messageControls(running, caps("reject"), "append");
  assert.equal(reject.blocked, true);
  const idle = messageControls({ status: "idle" } as ThreadSummary, caps("steer"), "append");
  assert.equal(idle.blocked, false);
});
