import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadSummary } from "./types.js";
import {
  SessionSearchStore,
  sessionSearchDocuments,
} from "./session-search.js";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    agentId: "codex",
    id: "thread-1",
    providerId: "local",
    name: "Search test",
    preview: "preview",
    cwd: "C:\\work",
    model: "gpt-test",
    status: "idle",
    updatedAt: 123,
    ...overrides,
  };
}

test("extracts only user and assistant text from normalized turns", () => {
  assert.deepEqual(
    sessionSearchDocuments({
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "find the regression" }],
            },
            { id: "agent-1", type: "agentMessage", text: "fixed it" },
            { id: "reason-1", type: "reasoning", summary: "private" },
            {
              id: "tool-1",
              type: "commandExecution",
              aggregatedOutput: "noisy output",
            },
          ],
        },
      ],
    }),
    {
      documents: [
        {
          turnId: "turn-1",
          itemId: "user-1",
          role: "user",
          text: "find the regression",
        },
        {
          turnId: "turn-1",
          itemId: "agent-1",
          role: "assistant",
          text: "fixed it",
        },
      ],
      truncated: false,
    },
  );
});

test("indexes, updates and removes session content", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deck-search-"));
  const store = new SessionSearchStore(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const summary = thread();
  store.upsert(summary, {
    turns: [
      {
        id: "turn-1",
        items: [
          { id: "u1", type: "userMessage", text: "session content lookup" },
          { id: "a1", type: "agentMessage", text: "已经修复登录异常" },
        ],
      },
    ],
  });
  const allowed = new Set(["codex:thread-1"]);
  assert.equal(store.needsIndex(summary), false);
  assert.equal(store.search("content lookup", allowed)[0]?.turnId, "turn-1");
  assert.equal(store.search("登录异常", allowed)[0]?.role, "assistant");

  const changed = thread({ updatedAt: 456 });
  assert.equal(store.needsIndex(changed), true);
  store.upsert(changed, {
    turns: [
      {
        id: "turn-2",
        items: [{ id: "u2", type: "userMessage", text: "replacement text" }],
      },
    ],
  });
  assert.deepEqual(store.search("content lookup", allowed), []);
  assert.equal(store.search("replacement", allowed)[0]?.turnId, "turn-2");

  store.removeAbsent([]);
  assert.deepEqual(store.search("replacement", allowed), []);
});
