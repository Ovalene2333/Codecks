import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeHistory } from "./claude-history.js";

function jsonl(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

test("Claude history follows the declared leaf and normalizes tools", () => {
  const parsed = parseClaudeHistory(
    jsonl([
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-1",
        cwd: "/work/project",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Implement the adapter" },
      },
      {
        type: "assistant",
        uuid: "a-branch",
        parentUuid: "u1",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "discarded branch" }],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            output_tokens: 5,
            context_window: 200_000,
          },
          content: [
            { type: "thinking", thinking: "Inspect files" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "a1",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "all green",
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "result-1",
        sessionId: "session-1",
        cwd: "/work/project",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "Done" }],
        },
      },
      { type: "custom-title", customTitle: "Claude adapter" },
      { type: "last-prompt", leafUuid: "a2", sessionId: "session-1" },
    ]),
    "/tmp/session-1.jsonl",
  );

  assert.ok(parsed);
  assert.equal(parsed.summary.agentId, "claude");
  assert.equal(parsed.summary.name, "Claude adapter");
  assert.equal(parsed.summary.preview, "Implement the adapter");
  assert.equal(parsed.summary.model, "claude-test");
  assert.deepEqual(parsed.summary.tokenUsage, {
    total: 22,
    used: 22,
    limit: 200_000,
    input: 13,
    cachedInput: 4,
    output: 5,
  });
  assert.equal(parsed.thread.turns.length, 1);
  assert.equal(
    parsed.thread.turns[0].items.some(
      (item: any) => item.text === "discarded branch",
    ),
    false,
  );
  const command = parsed.thread.turns[0].items.find(
    (item: any) => item.type === "commandExecution",
  );
  assert.equal(command.command, "npm test");
  assert.equal(command.status, "completed");
  assert.equal(command.aggregatedOutput, "all green");
});

test("Claude history tolerates malformed lines and empty sessions", () => {
  assert.equal(parseClaudeHistory("not-json", "/tmp/bad.jsonl"), undefined);
  const parsed = parseClaudeHistory(
    `${JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "from-record",
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    })}\n{broken`,
    "/tmp/fallback.jsonl",
    123,
  );
  assert.equal(parsed?.summary.id, "from-record");
  assert.equal(parsed?.summary.updatedAt, 123);
});
