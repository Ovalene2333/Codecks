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
