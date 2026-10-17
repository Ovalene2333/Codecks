import test from "node:test";
import assert from "node:assert/strict";
import {
  loadedUserMessages,
  reconcilePendingUserMessages,
} from "./optimistic.ts";

const pending = (id: string, text: string, previousText = "旧消息") => ({
  id,
  text,
  images: [],
  historyBefore: previousText
    ? loadedUserMessages([
        { items: [{ type: "userMessage", text: previousText }] },
      ])
    : [],
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
    reconcilePendingUserMessages(oldTurns, [
      pending("repeat", "再试一次", "再试一次"),
    ]),
    [pending("repeat", "再试一次", "再试一次")],
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
    reconcilePendingUserMessages(loadedTurns, [
      pending("repeat", "再试一次", "再试一次"),
    ]),
    [],
  );
});

test("history with injected context reconciles using the visible user text", () => {
  const turns = [
    {
      items: [
        {
          type: "userMessage",
          content: [
            {
              type: "text",
              text: "<environment_context>internal</environment_context>\n新消息",
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(
    reconcilePendingUserMessages(turns, [pending("new", "新消息", "")]),
    [],
  );
});

test("an intervening history item does not advance the pending message boundary", () => {
  const message = pending("new", "新消息", "");
  const intermediate = [
    { items: [{ type: "userMessage", text: "另一客户端的消息" }] },
  ];
  const retained = reconcilePendingUserMessages(intermediate, [message]);
  // 历史更新可能补齐同一个 turn 中更早的位置，不能把匹配起点移到末尾。
  assert.deepEqual(
    reconcilePendingUserMessages(
      [
        {
          items: [
            { type: "userMessage", text: "新消息" },
            ...intermediate[0].items,
          ],
        },
      ],
      retained,
    ),
    [],
  );
});

test("sending during initial loading cannot reconcile against a newly fetched old identical message", () => {
  const message = { ...pending("new", "继续", ""), sentAt: 10 };
  for (const startedAt of [1, undefined]) {
    const old = [
      {
        id: "old",
        startedAt,
        items: [{ id: "old-user", type: "userMessage", text: "继续" }],
      },
    ];
    assert.deepEqual(reconcilePendingUserMessages(old, [message]), [message]);
  }
  assert.deepEqual(
    reconcilePendingUserMessages(
      [
        {
          id: "new",
          startedAt: 12,
          items: [{ id: "new-user", type: "userMessage", text: "继续" }],
        },
      ],
      [message],
    ),
    [],
  );
});
