import assert from "node:assert/strict";
import test from "node:test";
import { CodexAdapter } from "./codex-adapter.js";

test("pending file changes are bounded and prune the oldest", () => {
  const manager = new CodexAdapter(
    { listPublic: () => [] } as any,
    "/tmp",
  ) as any;
  for (let index = 0; index < 1100; index++) {
    manager.onNotification({
      method: "item/updated",
      params: {
        item: {
          id: `item-${index}`,
          type: "fileChange",
          changes: [{ path: "a.ts", kind: "edit" }],
        },
      },
    });
  }
  assert.ok(manager.pendingFileChanges.size <= 1001);
  assert.equal(manager.pendingFileChanges.has("item-0"), false);
  assert.equal(manager.pendingFileChanges.has("item-1099"), true);
});

test("runtime crash unlocks busy threads and refresh cannot revive the turn", () => {
  const manager = new CodexAdapter(
    { listPublic: () => [] } as any,
    "/tmp",
  ) as any;
  manager.threads.set("t1", {
    id: "t1",
    providerId: "p1",
    name: "t",
    preview: "t",
    cwd: "",
    model: "default",
    status: "running",
    updatedAt: 1,
    activeTurnId: "turn-1",
  } as any);

  manager.markOffline();
  const offline = manager.threads.get("t1");
  assert.equal(offline.status, "offline");
  assert.equal(offline.interruptedTurnId, "turn-1");
  assert.equal(offline.activeTurnId, undefined);

  // Codex state DB still lists the killed turn as inProgress; refresh must
  // not promote it back to running.
  manager.upsertThread({ id: "p1" } as any, {
    id: "t1",
    cwd: "",
    turns: [{ id: "turn-1", status: "inProgress" }],
  });
  const stale = manager.threads.get("t1");
  assert.equal(stale.status, "error");
  assert.equal(stale.activeTurnId, undefined);
  assert.equal(stale.interruptedTurnId, "turn-1");
  assert.match(stale.lastError, /中断/);

  // A fresh turn clears the marker and restores normal running state.
  manager.onNotification({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn-2" } },
  });
  const revived = manager.threads.get("t1");
  assert.equal(revived.status, "running");
  assert.equal(revived.activeTurnId, "turn-2");
  assert.equal(revived.interruptedTurnId, undefined);
  assert.equal(revived.lastError, undefined);
});
