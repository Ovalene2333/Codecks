import assert from "node:assert/strict";
import test from "node:test";
import {
  branchClaudeHistory,
  parseClaudeHistory,
  rewindAnchorUuid,
  turnEndUuid,
} from "./claude-history.js";

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
  assert.equal(parsed.summary.model, "default");
  assert.equal(parsed.summary.resolvedModel, "claude-test");
  assert.equal(parsed.thread.model, "claude-test");
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

test("Claude history crosses attachment records and compact boundaries", () => {
  // Claude Code >=2.1 形态：parentUuid 链穿过 system/attachment 记录；
  // compact_boundary 之后另起 parentUuid=null 的新链，last-prompt 的
  // leafUuid 也可能指向非消息记录。两段都应并入同一条时间线。
  const parsed = parseClaudeHistory(
    jsonl([
      {
        type: "system",
        subtype: "informational",
        uuid: "sys-1",
        parentUuid: null,
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "user",
        uuid: "u1",
        parentUuid: "sys-1",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "first prompt" },
      },
      {
        type: "attachment",
        attachment: { type: "environment" },
        uuid: "att-1",
        parentUuid: "u1",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:01.500Z",
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "att-1",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "answer one" }],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary-1",
        parentUuid: null,
        logicalParentUuid: "a1",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:03.000Z",
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "boundary-1",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation",
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "u2",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "answer two" }],
        },
      },
      { type: "ai-title", aiTitle: "Segmented session", sessionId: "session-2" },
      { type: "last-prompt", leafUuid: "att-2", sessionId: "session-2" },
      {
        type: "attachment",
        attachment: { type: "total_tokens_reminder" },
        uuid: "att-2",
        parentUuid: "a2",
        sessionId: "session-2",
        timestamp: "2026-01-01T00:00:06.000Z",
      },
    ]),
    "/tmp/session-2.jsonl",
  );

  assert.ok(parsed);
  assert.equal(parsed.summary.id, "session-2");
  assert.equal(parsed.summary.name, "Segmented session");
  assert.equal(parsed.summary.preview, "first prompt");
  assert.equal(parsed.thread.turns.length, 2);
  const texts = parsed.thread.turns.flatMap((turn: any) =>
    turn.items.map((item: any) => item.text),
  );
  assert.ok(texts.includes("answer one"));
  assert.ok(texts.includes("answer two"));
});

test("Claude history rewind anchors and branching preserve the source", () => {
  const source = jsonl([
    {
      type: "system",
      subtype: "informational",
      uuid: "sys-1",
      parentUuid: null,
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "user",
      uuid: "u1",
      parentUuid: "sys-1",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "first question" },
    },
    {
      type: "attachment",
      attachment: { type: "environment" },
      uuid: "att-1",
      parentUuid: "u1",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:01.500Z",
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "att-1",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "answer one" }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: "second question" },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "answer two" }],
      },
    },
    { type: "ai-title", aiTitle: "Rewind demo", sessionId: "session-rw" },
    { type: "last-prompt", leafUuid: "a2", sessionId: "session-rw" },
  ]);

  // 重试第二条 prompt：锚点是它之前的最后一条主链消息 a1。
  assert.equal(rewindAnchorUuid(source, "u2"), "a1");
  // 首条消息之前没有消息：回滚到会话开头。
  assert.equal(rewindAnchorUuid(source, "u1"), null);
  // 不在主链上的 uuid（孤儿分支/传错）返回 undefined。
  assert.equal(rewindAnchorUuid(source, "ghost"), undefined);
  assert.equal(rewindAnchorUuid(source, "att-1"), undefined);

  // turn 末尾锚点：u1 所属 turn 的最后一条消息是 a1；末轮到链尾。
  assert.equal(turnEndUuid(source, "u1"), "a1");
  assert.equal(turnEndUuid(source, "u2"), "a2");
  assert.equal(turnEndUuid(source, "ghost"), undefined);

  // 截断分支：保留锚点行及之前 + 无 uuid 元数据，丢弃 last-prompt
  // 与锚点之后的链上记录；sessionId 全部重写。
  const truncated = branchClaudeHistory(source, "branch-1", "a1");
  assert.ok(truncated);
  const truncatedRows = truncated
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    truncatedRows.map((row) => row.uuid || row.type),
    ["sys-1", "u1", "att-1", "a1", "ai-title"],
  );
  assert.ok(
    truncatedRows.every(
      (row) =>
        row.sessionId === undefined || row.sessionId === "branch-1",
    ),
  );
  // 截断后的分支解析出来只剩第一个 turn。
  const reparsed = parseClaudeHistory(truncated, "/tmp/branch-1.jsonl");
  assert.equal(reparsed?.summary.id, "branch-1");
  assert.equal(reparsed?.thread.turns.length, 1);
  assert.equal(reparsed?.thread.turns[0].id, "u1");

  // 完整分支保留全部行（包括 last-prompt），sessionId 重写。
  const full = branchClaudeHistory(source, "branch-2");
  assert.ok(full);
  const fullRows = full
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(fullRows.length, 8);
  assert.ok(fullRows.some((row) => row.type === "last-prompt"));
  assert.ok(
    fullRows.every(
      (row) => row.sessionId === undefined || row.sessionId === "branch-2",
    ),
  );

  // 锚点不在文件里 → undefined；源内容不被改动。
  assert.equal(branchClaudeHistory(source, "branch-3", "ghost"), undefined);
  assert.ok(source.includes('"session-rw"'));
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

test("Claude history renders TodoWrite snapshots as extension todo items", () => {
  const parsed = parseClaudeHistory(
    jsonl([
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-todo",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Plan the work" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "session-todo",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            {
              type: "tool_use",
              id: "todo-tool-1",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "design", status: "completed", activeForm: "设计" },
                  { content: "build", status: "in_progress" },
                ],
              },
            },
          ],
        },
      },
    ]),
    "/tmp/session-todo.jsonl",
  );
  assert.ok(parsed);
  const item = parsed.thread.turns[0].items.find(
    (item: any) => item.type === "extension",
  );
  assert.equal(item.kind, "todo");
  assert.equal(item.agentId, "claude");
  assert.deepEqual(item.payload.todos, [
    { content: "design", status: "completed", activeForm: "设计" },
    { content: "build", status: "in_progress" },
  ]);
});
