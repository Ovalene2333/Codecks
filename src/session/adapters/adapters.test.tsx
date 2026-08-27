import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "../../types";
import { uiAdapterFor } from "./index";
import { claudeTodos, openCodePartToItem, todoState } from "./native-parts";

const thread = {
  agentId: "opencode",
  id: "thread-1",
  providerId: "openai",
  name: "Session",
  preview: "",
  cwd: "/work",
  model: "default",
  status: "idle",
  updatedAt: 1,
} as ThreadSummary;

test("OpenCode todo tool parts keep structured todos through normalization", () => {
  const item = openCodePartToItem({
    id: "prt-1",
    type: "tool",
    tool: "todowrite",
    state: {
      status: "completed",
      title: "Write todos",
      input: { todos: [{ content: "ship", status: "in_progress" }] },
      output: "ok",
    },
  });
  assert.equal(item.type, "commandExecution");
  assert.equal(item.tool, "todowrite");
  assert.equal(item.todos.length, 1);
  assert.equal(item.todos[0].content, "ship");
});

test("unknown OpenCode parts become extension items with the raw payload", () => {
  const part = { id: "prt-2", type: "choice", options: ["a"] };
  const item = openCodePartToItem(part);
  assert.deepEqual(
    { ...item, payload: item.payload },
    { id: "prt-2", type: "extension", kind: "choice", agentId: "opencode", payload: part },
  );
});

test("the OpenCode adapter renders todo payloads as a checklist panel", () => {
  const adapter = uiAdapterFor("opencode")!;
  const markup = renderToStaticMarkup(
    adapter.renderItem!(
      {
        id: "e1",
        type: "extension",
        kind: "todo",
        payload: { todos: [{ content: "alpha", status: "completed" }, { content: "beta" }] },
      },
      { thread },
    ) as any,
  );
  assert.match(markup, /todo-row/);
  assert.match(markup, /alpha/);
  assert.match(markup, /beta/);
  assert.match(markup, /1\/2/);
});

test("the OpenCode adapter falls back for core items it does not claim", () => {
  const adapter = uiAdapterFor("opencode")!;
  assert.equal(adapter.renderItem!({ type: "agentMessage", text: "hi" }, { thread }), undefined);
});

test("Claude TodoWrite input is converted into tolerant todo rows", () => {
  const todos = claudeTodos({ todos: [
    { content: "first", status: "pending" },
    "plain string",
    { content: "done", status: "completed" },
  ] });
  assert.equal(todos.length, 3);
  assert.equal(todoState(todos[0]), "pending");
  assert.equal(todos[1].content, "plain string");
  assert.equal(todoState(todos[2]), "completed");

  const adapter = uiAdapterFor("claude")!;
  const markup = renderToStaticMarkup(
    adapter.renderItem!(
      { id: "t1", type: "extension", kind: "todo", payload: { todos } },
      { thread: { ...thread, agentId: "claude" } },
    ) as any,
  );
  assert.match(markup, /待办事项|任务清单/);
  assert.match(markup, /first/);
});
