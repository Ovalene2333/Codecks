import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnBlock } from "./TurnBlock.tsx";
import type { ThreadSummary } from "../types.ts";

test("an active turn renders exactly one streaming cursor", () => {
  const thread: ThreadSummary = {
    id: "thread-1",
    providerId: "official",
    name: "会话",
    preview: "",
    cwd: "/tmp/project",
    model: "gpt",
    status: "running",
    updatedAt: Date.now(),
    activeTurnId: "turn-1",
  };
  const html = renderToStaticMarkup(
    createElement(TurnBlock, {
      turn: { id: "turn-1", status: "inProgress", items: [] },
      index: 1,
      thread,
      streamed: [
        { itemId: "message-1", text: "第一段" },
        { itemId: "message-2", text: "第二段" },
        { itemId: "message-3", text: "第三段" },
      ],
    }),
  );

  assert.equal((html.match(/message agent streaming/g) || []).length, 1);
  assert.equal((html.match(/<i><\/i>/g) || []).length, 1);
});
