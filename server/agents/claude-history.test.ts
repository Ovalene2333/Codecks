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

test("user images survive history normalization including image-only prompts", () => {
  const parsed = parseClaudeHistory(jsonl([
    { type: "user", uuid: "image-user", sessionId: "images", timestamp: "2026-10-03T00:00:00Z",
      message: { role: "user", content: [{ type: "image", source: {
        type: "base64", media_type: "image/png", data: "aGVsbG8=",
      } }] } },
  ]), "/tmp/images.jsonl");
  assert.equal(parsed?.thread.turns.length, 1);
  assert.deepEqual(parsed?.thread.turns[0].items[0].content, [
    { type: "text", text: "" }, { type: "image", url: "data:image/png;base64,aGVsbG8=" },
  ]);
});

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
    used: 17,
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

test("Claude history reads context tiers and final streamed usage", () => {
  const source = jsonl([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "tiered",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { content: "question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "tiered",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        id: "msg-1",
        model: "claude-opus-5-5",
        content: [],
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 1,
        },
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "a1",
      sessionId: "tiered",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        id: "msg-1",
        model: "claude-opus-5-5",
        content: [],
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 5,
        },
      },
    },
    {
      type: "assistant",
      uuid: "a3",
      parentUuid: "a2",
      sessionId: "tiered",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        id: "msg-2",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 90,
          output_tokens: 5,
        },
      },
    },
    { type: "cost-state", modelUsage: { "claude-opus-5-5[1m]": {} } },
  ]);
  const parsed = parseClaudeHistory(source, "/tmp/tiered.jsonl");
  assert.deepEqual(parsed?.summary.tokenUsage, {
    total: 115,
    used: 100,
    limit: 1_000_000,
    input: 12,
    cachedInput: 93,
    output: 10,
  });

  const standard = source
    .replaceAll("claude-opus-5-5[1m]", "claude-sonnet-5-5")
    .replaceAll("claude-opus-5-5", "claude-sonnet-5-5");
  assert.equal(
    parseClaudeHistory(standard, "/tmp/tiered.jsonl")?.summary.tokenUsage
      ?.limit,
    undefined,
  );
  const explicitRows = standard.split("\n").map((line) => JSON.parse(line));
  explicitRows.find((row) => row.uuid === "a3").message.usage.context_window =
    200_000;
  assert.equal(
    parseClaudeHistory(jsonl(explicitRows), "/tmp/tiered.jsonl")?.summary
      .tokenUsage?.limit,
    200_000,
  );
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
          content:
            "This session is being continued from a previous conversation",
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
      {
        type: "ai-title",
        aiTitle: "Segmented session",
        sessionId: "session-2",
      },
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
      (row) => row.sessionId === undefined || row.sessionId === "branch-1",
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

test("Claude history hides local command echoes and compact internals", () => {
  const source = jsonl([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "real question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "real answer" }],
      },
    },
    // 本地命令回显：无任何标志位的普通 user 记录
    {
      type: "user",
      uuid: "cmd-1",
      parentUuid: "a1",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "user",
        content:
          "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-sonnet-5-5</command-args>",
      },
    },
    {
      type: "user",
      uuid: "out-1",
      parentUuid: "cmd-1",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "user",
        content:
          "<local-command-stdout>Set model to `claude-sonnet-5-5`</local-command-stdout>",
      },
    },
    // !cmd 的 bash 回显
    {
      type: "user",
      uuid: "bash-1",
      parentUuid: "out-1",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "user", content: "<bash-input>ls -la</bash-input>" },
    },
    // compact：边界 + 续接摘要（带官方标志）
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      parentUuid: null,
      logicalParentUuid: "bash-1",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:05.000Z",
    },
    {
      type: "user",
      uuid: "sum-1",
      parentUuid: "boundary-1",
      sessionId: "session-lc",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      timestamp: "2026-01-01T00:00:06.000Z",
      message: {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion",
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "sum-1",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:07.000Z",
      message: { role: "user", content: "next real question" },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      sessionId: "session-lc",
      timestamp: "2026-01-01T00:00:08.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "answer two" }],
      },
    },
  ]);
  const parsed = parseClaudeHistory(source, "/tmp/session-lc.jsonl");

  assert.ok(parsed);
  // 只剩两个真实 turn：内部记录不开 turn、不当边界。
  assert.equal(parsed.thread.turns.length, 2);
  assert.equal(parsed.thread.turns[0].id, "u1");
  assert.equal(parsed.thread.turns[1].id, "u2");
  const all = parsed.thread.turns.flatMap((turn: any) =>
    turn.items.flatMap((item: any) => [
      item.text,
      ...(item.content || []).map((part: any) => part.text),
    ]),
  );
  assert.ok(
    !all.some(
      (text) => typeof text === "string" && text.includes("command-name"),
    ),
  );
  assert.ok(
    !all.some(
      (text) => typeof text === "string" && text.includes("local-command"),
    ),
  );
  assert.ok(
    !all.some(
      (text) => typeof text === "string" && text.includes("being continued"),
    ),
  );
  // 预览取第一条真实用户消息，不是命令回显。
  assert.equal(parsed.summary.preview, "real question");
  // 内部记录不能做 rewind/turn 锚点，也不改变真实锚点位置。
  assert.equal(rewindAnchorUuid(source, "cmd-1"), undefined);
  assert.equal(rewindAnchorUuid(source, "u2"), "a1");
  assert.equal(turnEndUuid(source, "u1"), "a1");
});

test("Claude history hides interrupt echoes but keeps tool results", () => {
  const source = jsonl([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "session-int",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "real question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "session-int",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [
          {
            type: "tool_use",
            id: "toolu-1",
            name: "AskUserQuestion",
            input: { questions: [] },
          },
        ],
      },
    },
    // 中断标记作为 tool_result 回执：不是内部记录，要让工具项收口。
    {
      type: "user",
      uuid: "tr1",
      parentUuid: "a1",
      sessionId: "session-int",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-1",
            is_error: true,
            content: [
              {
                type: "text",
                text: "[Request interrupted by user for tool use]",
              },
            ],
          },
        ],
      },
    },
    // 纯文本中断回显的两种形态：字符串 content 与 text part 数组。
    {
      type: "user",
      uuid: "e1",
      parentUuid: "tr1",
      sessionId: "session-int",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "user",
        content: "[Request interrupted by user for tool use]",
      },
    },
    {
      type: "user",
      uuid: "e2",
      parentUuid: "e1",
      sessionId: "session-int",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "e2",
      sessionId: "session-int",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "user", content: "next real question" },
    },
  ]);
  const parsed = parseClaudeHistory(source, "/tmp/session-int.jsonl");

  assert.ok(parsed);
  // 中断回显不开 turn、不渲染成用户气泡。
  assert.equal(parsed.thread.turns.length, 2);
  assert.equal(parsed.thread.turns[0].id, "u1");
  assert.equal(parsed.thread.turns[1].id, "u2");
  const userText = parsed.thread.turns.flatMap((turn: any) =>
    turn.items
      .filter((item: any) => item.type === "userMessage")
      .flatMap((item: any) => item.content.map((part: any) => part.text)),
  );
  assert.deepEqual(userText, ["real question", "next real question"]);
  // 同名标记在 tool_result 里时仍生效：被打断的工具以 failed 收口，
  // 标记文本保留在工具输出（折叠详情）里。
  const tool = parsed.thread.turns[0].items.find(
    (item: any) => item.tool === "AskUserQuestion",
  );
  assert.equal(tool.status, "failed");
  // 中断回显不能做 rewind 锚点；u2 的回滚锚点落在 tool_result 记录上。
  assert.equal(rewindAnchorUuid(source, "e1"), undefined);
  assert.equal(rewindAnchorUuid(source, "u2"), "tr1");
  assert.equal(turnEndUuid(source, "u1"), "tr1");
});

test("Claude history drops injected-context echoes and strips inline blocks", () => {
  const source = jsonl([
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "session-inj",
      timestamp: "2026-01-01T00:00:00.000Z",
      // 真实提问 + 内联 system-reminder：保留为 turn，气泡只显示提问。
      message: {
        role: "user",
        content:
          "帮我看下这个\n\n<system-reminder>\ninternal note\n</system-reminder>",
      },
    },
    // 整条注入块：不开 turn、不进气泡。
    {
      type: "user",
      uuid: "sr1",
      parentUuid: "u1",
      sessionId: "session-inj",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nThe file changed.\n</system-reminder>",
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "tn1",
      parentUuid: "sr1",
      sessionId: "session-inj",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "user",
        content:
          "<task-notification>\nBackground task done\n</task-notification>",
      },
    },
    // 本地命令输出前的 Caveat 前缀记录。
    {
      type: "user",
      uuid: "cv1",
      parentUuid: "tn1",
      sessionId: "session-inj",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "user",
        content:
          "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages",
      },
    },
    // 空内容记录：不开 turn。
    {
      type: "user",
      uuid: "empty1",
      parentUuid: "cv1",
      sessionId: "session-inj",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "user", content: "" },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "empty1",
      sessionId: "session-inj",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "user", content: "下一个问题" },
    },
  ]);
  const parsed = parseClaudeHistory(source, "/tmp/session-inj.jsonl");

  assert.ok(parsed);
  assert.equal(parsed.thread.turns.length, 2);
  assert.equal(parsed.thread.turns[0].id, "u1");
  assert.equal(parsed.thread.turns[1].id, "u2");
  // 内联注入块不进气泡。
  assert.deepEqual(
    parsed.thread.turns[0].items[0].content.map((part: any) => part.text),
    ["帮我看下这个"],
  );
  const all = parsed.thread.turns.flatMap((turn: any) =>
    turn.items.flatMap((item: any) => [
      item.text,
      ...(item.content || []).map((part: any) => part.text),
    ]),
  );
  for (const leak of ["system-reminder", "task-notification", "Caveat"])
    assert.ok(
      !all.some((text) => typeof text === "string" && text.includes(leak)),
      `leaked ${leak}`,
    );
  // 内部回显不做 rewind 锚点（undefined）；非 prompt 的空记录仍在主链上，
  // u2 的锚点落在它身上。
  assert.equal(rewindAnchorUuid(source, "sr1"), undefined);
  assert.equal(rewindAnchorUuid(source, "u2"), "empty1");
  assert.equal(turnEndUuid(source, "u1"), "empty1");
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
                  {
                    content: "design",
                    status: "completed",
                    activeForm: "设计",
                  },
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

test("readClaudeHistoryCached reuses the parse until the file changes", async () => {
  const { mkdtemp, writeFile, appendFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readClaudeHistoryCached, resetClaudeHistoryCacheForTests } =
    await import("./claude-history.js");
  resetClaudeHistoryCacheForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-cache-"));
  const file = path.join(root, "session-c.jsonl");
  const row = (uuid: string, parentUuid: string | null, text: string) => ({
    type: "user",
    uuid,
    parentUuid,
    sessionId: "session-c",
    cwd: "/work",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text },
  });
  try {
    await writeFile(file, jsonl([row("u1", null, "first")]));
    const first = await readClaudeHistoryCached(file);
    assert.equal(first?.thread.turns.length, 1);
    // 调用方就地改 turn（stampTurnModels）不能污染缓存里的原件。
    first!.thread.turns[0].model = "stamped";
    const again = await readClaudeHistoryCached(file);
    assert.equal(again?.thread.turns[0].model, undefined);
    assert.notEqual(again?.thread.turns, first?.thread.turns);

    await appendFile(file, `\n${JSON.stringify(row("u2", "u1", "second"))}`);
    const changed = await readClaudeHistoryCached(file);
    assert.equal(changed?.thread.turns.length, 2);
  } finally {
    resetClaudeHistoryCacheForTests();
    await rm(root, { recursive: true, force: true });
  }
});
