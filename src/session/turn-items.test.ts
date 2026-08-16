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
