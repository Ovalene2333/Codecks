import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePendingUserMessages } from "./optimistic.ts";

const pending = (id: string, text: string, loadedUserMessageCount = 1) => ({
  id,
  text,
  images: [],
  loadedUserMessageCount,
});

test("optimistic bubbles disappear after matching user messages load", () => {
  const turns = [
    {
      items: [
        { type: "userMessage", content: [{ type: "text", text: "旧消息" }] },
      ],
    },
    {
      items: [
        { type: "userMessage", content: [{ type: "text", text: "新消息" }] },
      ],
    },
  ];
  assert.deepEqual(
    reconcilePendingUserMessages(turns, [pending("new", "新消息")]),
    [],
  );
});

test("optimistic bubbles remain while the server has not loaded them", () => {
  const turns = [
    {
      items: [
        { type: "userMessage", content: [{ type: "text", text: "旧消息" }] },
      ],
    },
  ];
  assert.deepEqual(
    reconcilePendingUserMessages(turns, [pending("new", "新消息")]),
    [pending("new", "新消息")],
  );
});

test("resending identical text does not match the older history message", () => {
  const oldTurns = [
    {
      items: [
        { type: "userMessage", content: [{ type: "text", text: "再试一次" }] },
      ],
    },
  ];
  assert.deepEqual(
    reconcilePendingUserMessages(oldTurns, [pending("repeat", "再试一次")]),
    [pending("repeat", "再试一次")],
  );

  const loadedTurns = [
    ...oldTurns,
    {
      items: [
        { type: "userMessage", content: [{ type: "text", text: "再试一次" }] },
      ],
    },
  ];
  assert.deepEqual(
    reconcilePendingUserMessages(loadedTurns, [pending("repeat", "再试一次")]),
    [],
  );
});
