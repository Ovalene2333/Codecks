import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundSearchStore } from "./session-search-background.js";
import { closeBackgroundWork } from "./background-work.js";

test("worker search persists, isolates tools, and refuses stale transcript replacement", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-worker-search-"));
  t.after(async () => {
    await closeBackgroundWork();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new BackgroundSearchStore(dir);
  const thread = { agentId: "codex", id: "demo", updatedAt: 2 } as any;
  const allowed = new Set(["codex:demo"]);
  assert.equal((await store.reconcile([thread])).length, 1);
  await store.upsert(thread, {
    turns: [
      {
        id: "t",
        items: [
          {
            type: "userMessage",
            content: [{ type: "text", text: "searchable request" }],
          },
          { type: "agentMessage", text: "searchable response" },
          {
            type: "commandExecution",
            aggregatedOutput: "excludedtooloutput".repeat(100_000),
          },
        ],
      },
    ],
  });
  assert.equal(await store.indexedCount(allowed), 1);
  assert.equal((await store.search("searchable", allowed)).length, 2);
  assert.deepEqual(await store.search("excludedtooloutput", allowed), []);
  await store.upsert({ ...thread, updatedAt: 1 }, { turns: [] });
  assert.equal((await store.search("searchable", allowed)).length, 2);
  assert.deepEqual(await store.reconcile([thread]), []);
  await store.reconcile([]);
  assert.deepEqual(await store.search("searchable", allowed), []);
});
