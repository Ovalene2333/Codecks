import assert from "node:assert/strict";
import test from "node:test";
import { SessionSearchIndexer } from "./session-search-indexer.js";

test("search indexing yields to foreground interaction and requests complete background history", async () => {
  let interacting = true;
  const reads: any[] = [];
  const indexed: any[] = [];
  const thread = { agentId: "opencode", id: "demo", status: "idle", updatedAt: 1 };
  const store = { upsert: (...args: any[]) => indexed.push(args), close: () => {} };
  const agents = {
    busyThreads: () => [], historyInteractionActive: () => interacting,
    readThread: async (...args: any[]) => { reads.push(args); return { turns: [] }; },
  };
  const indexer = new SessionSearchIndexer(store as any, agents as any);
  try {
    (indexer as any).queue = [thread];
    await (indexer as any).processOne();
    assert.equal(reads.length, 0);
    assert.equal((indexer as any).queue.length, 1);
    interacting = false;
    await (indexer as any).processOne();
    assert.deepEqual(reads, [["opencode", "demo", { background: true }]]);
    assert.equal(indexed.length, 1);
  } finally { indexer.close(); }
});

test("tail pages must never replace complete search documents", async () => {
  let captures = 0;
  const indexer = new SessionSearchIndexer({
    upsert: () => captures++, close: () => {},
  } as any, { busyThreads: () => [] } as any);
  try {
    indexer.capture({ id: "demo" } as any, { turns: [], __cachedTailOmitted: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(captures, 0);
  } finally { indexer.close(); }
});

test("HTTP pagination after capture cannot truncate the indexed transcript", async () => {
  const captured: any[] = [];
  const indexer = new SessionSearchIndexer({
    upsert: (_thread: any, full: any) => captured.push(full), close: () => {},
  } as any, { busyThreads: () => [] } as any);
  try {
    const full = { turns: [{ id: "old" }, { id: "new" }] };
    indexer.capture({ id: "demo" } as any, full);
    full.turns = full.turns.slice(-1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(captured[0].turns.map((turn: any) => turn.id), ["old", "new"]);
  } finally { indexer.close(); }
});
