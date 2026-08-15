import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadSummaryCache } from "./thread-summary-cache.js";

const thread = {
  agentId: "codex" as const,
  id: "thread-1",
  providerId: "official",
  cwd: "/work",
  preview: "cached",
  model: "gpt-test",
  status: "idle" as const,
  updatedAt: 42,
};

test("thread summary cache atomically persists active and archived rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-cache-"));
  const cache = new ThreadSummaryCache(dir);
  cache.schedule([thread], [{ ...thread, id: "archived", archived: true }]);
  await cache.flush();

  const loaded = await new ThreadSummaryCache(dir).load();
  assert.equal(loaded.threads[0]?.id, "thread-1");
  assert.equal(loaded.archivedThreads[0]?.id, "archived");
  assert.doesNotMatch(
    await readFile(path.join(dir, "thread-summaries.json"), "utf8"),
    /turns/,
  );
});

test("thread summary cache ignores malformed rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-cache-bad-"));
  const cache = new ThreadSummaryCache(dir);
  cache.schedule([thread, { id: "bad" } as any]);
  await cache.flush();
  assert.deepEqual(
    (await new ThreadSummaryCache(dir).load()).threads.map((item) => item.id),
    ["thread-1"],
  );
});
