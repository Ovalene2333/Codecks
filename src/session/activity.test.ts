import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadSummary } from "../types.ts";
import { sessionKey } from "../format.ts";
import {
  completedThreads,
  reconcileUnseenSessions,
  threadStatusMap,
} from "./activity.ts";

function thread(
  status: ThreadSummary["status"],
  id = "thread-1",
): ThreadSummary {
  return {
    id,
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status,
    updatedAt: 1,
  };
}

test("only a completed active session becomes a new reply", () => {
  const previous = threadStatusMap([
    thread("running", "done"),
    thread("idle", "already-idle"),
    thread("running", "failed"),
  ]);
  const next = [
    thread("idle", "done"),
    thread("idle", "already-idle"),
    thread("error", "failed"),
  ];

  assert.deepEqual(
    completedThreads(previous, next).map((item) => item.id),
    ["done"],
  );
});

test("visible selected sessions are considered seen", () => {
  const previous = threadStatusMap([thread("running")]);
  const key = sessionKey(thread("idle"));

  assert.deepEqual(
    [
      ...reconcileUnseenSessions({
        current: new Set(),
        previous,
        threads: [thread("idle")],
        selected: key,
        visible: true,
      }),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...reconcileUnseenSessions({
        current: new Set(),
        previous,
        threads: [thread("idle")],
        selected: key,
        visible: false,
      }),
    ],
    [key],
  );
});

test("opening a session clears its persisted new reply state", () => {
  const key = sessionKey(thread("idle"));
  const result = reconcileUnseenSessions({
    current: new Set([key]),
    previous: threadStatusMap([thread("idle")]),
    threads: [thread("idle")],
    selected: key,
    visible: true,
  });
  assert.equal(result.has(key), false);
});
