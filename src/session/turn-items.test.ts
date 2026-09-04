import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "../types";
import { TurnBlock } from "./TurnBlock";
import {
  commandPresentation,
  fileChangeGroupLabel,
  groupTurnItems,
  isTrivialToolOutput,
  openCodeFileTarget,
  reasoningText,
  toolCallPresentation,
  turnReadTargets,
} from "./turn-items";

test("groups consecutive file changes and multi-file updates", () => {
  const grouped = groupTurnItems([
    { id: "a", type: "fileChange", changes: [{ path: "a", kind: "update" }] },
    { id: "b", type: "fileChange", changes: [{ path: "b", kind: "update" }] },
    { id: "c", type: "agentMessage", text: "done" },
    {
      id: "d",
      type: "fileChange",
      changes: [
        { path: "c", kind: "add" },
        { path: "d", kind: "update" },
      ],
    },
  ]);
  assert.equal(grouped[0].kind, "fileChangeGroup");
  assert.equal(grouped[1].kind, "item");
  assert.equal(grouped[2].kind, "fileChangeGroup");
  assert.equal(fileChangeGroupLabel((grouped[0] as any).changes), "update");
  assert.equal(fileChangeGroupLabel((grouped[2] as any).changes), "changes");
});

test("omits empty reasoning items while preserving visible summaries", () => {
  const grouped = groupTurnItems([
    { id: "empty", type: "reasoning", summary: [] },
    { id: "whitespace", type: "reasoning", content: "   \n" },
    {
      id: "visible",
      type: "reasoning",
      summary: "  检查协议事件  ",
    },
    { id: "message", type: "agentMessage", text: "完成" },
  ]);

  assert.deepEqual(
    grouped.map((entry) =>
      entry.kind === "item" ? entry.item.id : entry.kind,
    ),
    ["visible", "message"],
  );
  assert.equal(reasoningText((grouped[0] as any).item), "检查协议事件");
});

test("classifies Codex read and explore command actions", () => {
  assert.deepEqual(
    commandPresentation(
      {
        commandActions: [
          { type: "read", path: "/work/src/App.tsx", name: "App.tsx" },
        ],
      },
      "/work",
    ),
    { kind: "read", label: "读取", target: "src/App.tsx" },
  );
  assert.deepEqual(
    commandPresentation(
      {
        commandActions: [
          { type: "search", query: "tool-row", path: "/work/src" },
        ],
      },
      "/work",
    ),
    { kind: "explore", label: "检索", target: "tool-row · src" },
  );
});

test("summarizes unique files read by commands and file tools", () => {
  assert.deepEqual(
    turnReadTargets(
      [
        {
          type: "commandExecution",
          commandActions: [
            { type: "read", path: "/work/src/App.tsx" },
            { type: "read", path: "/work/src/App.tsx" },
            { type: "search", path: "/work/src" },
          ],
        },
        {
          type: "mcpToolCall",
          tool: "workspace/read_file",
          arguments: { file_path: "/work/README.md" },
        },
        {
          type: "dynamicToolCall",
          tool: "search",
          input: { path: "/work/ignored.ts" },
        },
      ],
      "/work",
    ),
    ["src/App.tsx", "README.md"],
  );
});

test("maps OpenCode edit tools to Chinese labels with file targets", () => {
  assert.deepEqual(
    commandPresentation(
      {
        type: "commandExecution",
        tool: "edit",
        command: "docs/HANDOVER.md",
        input: { filePath: "/work/docs/HANDOVER.md" },
      },
      "/work",
    ),
    { kind: "edit", label: "编辑", target: "docs/HANDOVER.md" },
  );
  assert.deepEqual(
    commandPresentation(
      {
        type: "commandExecution",
        tool: "read",
        command: "Read src/main.ts",
        input: { filePath: "/work/src/main.ts" },
      },
      "/work",
    ),
    { kind: "read", label: "读取", target: "src/main.ts" },
  );
  assert.equal(openCodeFileTarget({ input: { filePath: "/work/a.ts" } }, "/work"), "a.ts");
  assert.equal(isTrivialToolOutput("Edit applied successfully."), true);
  assert.equal(isTrivialToolOutput("wrote 12 lines"), false);
});

test("groups consecutive OpenCode edits into one tool group", () => {
  const grouped = groupTurnItems([
    {
      id: "e1",
      type: "commandExecution",
      tool: "edit",
      command: "docs/HANDOVER.md",
      input: { filePath: "/work/docs/HANDOVER.md" },
      aggregatedOutput: "Edit applied successfully.",
    },
    {
      id: "e2",
      type: "commandExecution",
      tool: "edit",
      command: "docs/HANDOVER.md",
      input: { filePath: "/work/docs/HANDOVER.md" },
      aggregatedOutput: "Edit applied successfully.",
    },
    { id: "m", type: "agentMessage", text: "done" },
    {
      id: "e3",
      type: "commandExecution",
      tool: "edit",
      command: "docs/OTHER.md",
      input: { filePath: "/work/docs/OTHER.md" },
      aggregatedOutput: "Edit applied successfully.",
    },
  ]);
  assert.equal(grouped[0].kind, "toolGroup");
  assert.equal((grouped[0] as any).items.length, 2);
  assert.equal(grouped[1].kind, "item");
  //  solitary edit stays a single row (now rendered as 编辑).
  assert.equal(grouped[2].kind, "item");
});

test("includes OpenCode reads in the per-turn read summary", () => {
  assert.deepEqual(
    turnReadTargets(
      [
        {
          type: "commandExecution",
          tool: "read",
          command: "Read src/main.ts",
          input: { filePath: "/work/src/main.ts" },
        },
      ],
      "/work",
    ),
    ["src/main.ts"],
  );
});

test("extracts dynamic and MCP tool input and output", () => {
  assert.deepEqual(
    toolCallPresentation({
      type: "mcpToolCall",
      server: "workspace",
      tool: "read",
      arguments: { path: "README.md" },
      result: { content: [{ type: "text", text: "hello" }] },
    }),
    {
      tool: "read",
      scope: "workspace",
      input: '{\n  "path": "README.md"\n}',
      output: "hello",
    },
  );
});

test("TurnBlock renders read overview, collapsed updates, and expandable tools", () => {
  const thread: ThreadSummary = {
    id: "thread",
    providerId: "provider",
    name: "QA",
    preview: "",
    cwd: "/work",
    model: "gpt",
    status: "idle",
    updatedAt: 1,
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      index: 1,
      thread,
      streamed: [],
      turn: {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "change",
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "/work/src/a.ts", kind: "update", diff: "+a" },
              { path: "/work/src/b.ts", kind: "update", diff: "+b" },
            ],
          },
          {
            id: "read",
            type: "commandExecution",
            status: "completed",
            command: "sed -n '1,20p' src/a.ts",
            commandActions: [
              { type: "read", path: "/work/src/a.ts", name: "a.ts" },
            ],
            aggregatedOutput: "const a = 1;",
          },
          {
            id: "explore",
            type: "commandExecution",
            status: "completed",
            command: "rg tool src",
            commandActions: [
              { type: "search", query: "tool", path: "/work/src" },
            ],
            aggregatedOutput: "src/a.ts:1:tool",
          },
          {
            id: "read-b",
            type: "commandExecution",
            status: "completed",
            command: "cat README.md",
            commandActions: [{ type: "read", path: "/work/README.md" }],
            aggregatedOutput: "docs",
          },
        ],
      },
    }),
  );
  assert.match(html, /class="tool-row file-change-group ok"/);
  assert.doesNotMatch(html, /<details[^>]*file-change-group[^>]* open/);
  assert.match(html, />update</);
  assert.match(html, />2 个文件</);
  assert.match(html, /本轮已读取/);
  assert.match(html, />2 个文件</);
  assert.match(html, />读取</);
  assert.match(html, /const a = 1;/);
  assert.match(html, />检索</);
  assert.match(html, /src\/a\.ts:1:tool/);
});

test("TurnBlock renders subagent cards with status and expandable output", () => {
  const thread: ThreadSummary = {
    id: "thread",
    providerId: "provider",
    name: "QA",
    preview: "",
    cwd: "/work",
    model: "gpt",
    status: "idle",
    updatedAt: 1,
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      index: 1,
      thread,
      streamed: [],
      turn: {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "task-running",
            type: "subagent",
            title: "探索代码库",
            agent: "explore",
            status: "inProgress",
            activity: "正在读取 src 目录",
            aggregatedOutput: "",
          },
          {
            id: "task-done",
            type: "subagent",
            title: "审查改动",
            agent: "general",
            status: "completed",
            aggregatedOutput: "共 3 处建议",
          },
        ],
      },
    }),
  );
  assert.match(html, /class="tool-row subagent-row running"/);
  assert.match(html, /子代理执行中/);
  assert.match(html, /class="subagent-activity"[^>]*>正在读取 src 目录</);
  assert.match(html, /class="tool-row subagent-row ok"/);
  assert.match(html, /审查改动/);
  assert.match(html, /explore/);
  assert.match(html, /共 3 处建议/);
});

test("TurnBlock collapses consecutive OpenCode edits and hides trivial output", () => {
  const thread: ThreadSummary = {
    id: "thread",
    providerId: "provider",
    name: "QA",
    preview: "",
    cwd: "/work",
    model: "gpt",
    status: "idle",
    updatedAt: 1,
  };
  const edit = (id: string, output = "Edit applied successfully.") => ({
    id,
    type: "commandExecution",
    tool: "edit",
    status: "completed",
    command: "docs/HANDOVER.md",
    input: { filePath: "/work/docs/HANDOVER.md" },
    aggregatedOutput: output,
  });
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      index: 1,
      thread,
      streamed: [],
      turn: {
        id: "turn",
        status: "completed",
        items: [edit("e1"), edit("e2"), edit("e3")],
      },
    }),
  );
  // Three stacked rows become one collapsed group row.
  assert.match(html, /tool-group edit-group/);
  assert.match(html, /3 次/);
  assert.match(html, /docs\/HANDOVER\.md/);
  assert.doesNotMatch(html, /Edit applied successfully/);

  const single = renderToStaticMarkup(
    createElement(TurnBlock, {
      index: 1,
      thread,
      streamed: [],
      turn: { id: "turn", status: "completed", items: [edit("solo")] },
    }),
  );
  assert.match(single, />编辑</);
  assert.doesNotMatch(single, /Edit applied successfully/);

  const failing = renderToStaticMarkup(
    createElement(TurnBlock, {
      index: 1,
      thread,
      streamed: [],
      turn: {
        id: "turn",
        status: "completed",
        items: [edit("err", "Error: conflict in docs/HANDOVER.md")],
      },
    }),
  );
  assert.match(failing, /conflict in docs\/HANDOVER\.md/);
});
