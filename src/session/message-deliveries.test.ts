import assert from "node:assert/strict";
import test from "node:test";
import type { MessageDelivery } from "../types";
import {
  mergeMessageDeliveries,
  visibleMessageDeliveries,
} from "./message-deliveries";
import { loadedUserMessages } from "./user-message-reconcile";

const thread = { id: "t", agentId: "codex", activeTurnId: "new" };
const delivery: MessageDelivery = {
  id: "d",
  threadId: "t",
  agentId: "codex",
  mode: "queue",
  status: "delivered",
  text: "再试一次",
  preview: "再试一次",
  imageCount: 0,
  turnId: "new",
  createdAt: 1,
  updatedAt: 2,
};
const turn = (id: string, text = delivery.text) => ({
  id,
  items: [{ type: "userMessage", content: [{ type: "text", text }] }],
});

test("accepted messages stay visible until the corresponding transcript is loaded", () => {
  assert.deepEqual(visibleMessageDeliveries([delivery], thread, []), [
    delivery,
  ]);
  assert.deepEqual(
    visibleMessageDeliveries([delivery], thread, [turn("old")]),
    [delivery],
  );
  assert.deepEqual(
    visibleMessageDeliveries([delivery], thread, [turn("new")]),
    [],
  );
  assert.deepEqual(
    visibleMessageDeliveries([delivery], thread, [
      turn(
        "new",
        "<environment_context>internal</environment_context>\n再试一次",
      ),
    ]),
    [],
  );
});

test("HTTP receipts cover the snapshot gap and snapshots update the same bubble", () => {
  const receipt = { ...delivery, status: "queued" as const };
  assert.deepEqual(mergeMessageDeliveries([], [receipt]), [receipt]);
  assert.deepEqual(mergeMessageDeliveries([delivery], [receipt]), [delivery]);
});

test("identical feedback does not match an older message in the same turn", () => {
  const old = turn("new");
  const starts = new Map([[delivery.id, loadedUserMessages([old])]]);
  assert.deepEqual(
    visibleMessageDeliveries([delivery], thread, [old], starts),
    [delivery],
  );
  const updated = { ...old, items: [...old.items, ...old.items] };
  assert.deepEqual(
    visibleMessageDeliveries([delivery], thread, [updated], starts),
    [],
  );
});

test("matching consumes each history message once and includes image counts", () => {
  const second = { ...delivery, id: "second" };
  assert.deepEqual(
    visibleMessageDeliveries([delivery, second], thread, [turn("new")]),
    [second],
  );
  const images = { ...delivery, text: "", imageCount: 1 };
  assert.deepEqual(
    visibleMessageDeliveries([images], thread, [turn("new", "")]),
    [images],
  );
  assert.deepEqual(
    visibleMessageDeliveries([images], thread, [
      {
        id: "new",
        items: [
          {
            type: "userMessage",
            content: [{ type: "image", url: "data:image/png;base64,a" }],
          },
        ],
      },
    ]),
    [],
  );
});

test("historical delivered receipts never become bottom bubbles during initial or partial loading", () => {
  const idle = { id: "t", agentId: "codex" };
  assert.deepEqual(visibleMessageDeliveries([delivery], idle, []), []);
  assert.deepEqual(
    visibleMessageDeliveries([delivery], idle, [turn("unrelated-cache-tail")]),
    [],
  );
  assert.deepEqual(
    visibleMessageDeliveries(
      [delivery],
      idle,
      [],
      undefined,
      new Set([delivery.id]),
    ),
    [delivery],
  );
});

test("sending and delivered reconcile when a new turn is prepended to older history", () => {
  const old = {
    id: "old",
    items: [{ id: "old-user", type: "userMessage", text: "旧消息" }],
  };
  const starts = new Map([[delivery.id, loadedUserMessages([old])]]);
  assert.deepEqual(
    visibleMessageDeliveries([delivery], thread, [turn("new"), old], starts),
    [],
  );
  assert.deepEqual(
    visibleMessageDeliveries(
      [{ ...delivery, status: "sending" }],
      thread,
      [turn("new"), old],
      starts,
    ),
    [],
  );
});

test("ACP replay turn IDs consume completed receipts without creating duplicates", () => {
  const acp = { ...delivery, agentId: "devin" };
  const acpThread = { ...thread, agentId: "devin", activeTurnId: "new" };
  assert.deepEqual(
    visibleMessageDeliveries([acp], acpThread, [turn("acp-replay-1")]),
    [],
  );
});

test("identical ACP prompts remain one-to-one when runtime IDs become replay IDs", () => {
  const acpThread = { ...thread, agentId: "devin", activeTurnId: "new" };
  const old = {
    ...delivery,
    id: "old-receipt",
    agentId: "devin",
    turnId: "old",
  };
  const next = { ...delivery, id: "next-receipt", agentId: "devin" };
  const baseline = new Map([[next.id, loadedUserMessages([turn("old")])]]);
  assert.deepEqual(
    visibleMessageDeliveries(
      [old, next],
      acpThread,
      [turn("acp-replay-1")],
      baseline,
    ),
    [next],
  );
  assert.deepEqual(
    visibleMessageDeliveries(
      [old, next],
      acpThread,
      [turn("acp-replay-1"), turn("acp-replay-2")],
      baseline,
    ),
    [],
  );
});

test("both sent and loaded messages use the same injected-context and line-ending normalization", () => {
  const raw = {
    ...delivery,
    text: "<environment_context>injected</environment_context>\r\n第一行\r\n第二行",
  };
  assert.deepEqual(
    visibleMessageDeliveries([raw], thread, [turn("new", "第一行\n第二行")]),
    [],
  );
});

test("other sessions and old preview-only completion records do not create bubbles", () => {
  assert.deepEqual(
    visibleMessageDeliveries(
      [
        { ...delivery, threadId: "other" },
        { ...delivery, agentId: "claude" },
        { ...delivery, text: undefined },
      ],
      thread,
      [],
    ),
    [],
  );
});

test("OpenCode native history IDs reconcile by send time, excluding identical older messages", () => {
  const opencode = { ...delivery, agentId: "opencode", sentAt: 10 };
  const native = (startedAt: number) => ({
    ...turn("native-user-id"),
    startedAt,
  });
  assert.deepEqual(
    visibleMessageDeliveries([opencode], { ...thread, agentId: "opencode" }, [
      native(5),
    ]),
    [opencode],
  );
  assert.deepEqual(
    visibleMessageDeliveries([opencode], { ...thread, agentId: "opencode" }, [
      native(10),
    ]),
    [],
  );
});

test("Claude user UUIDs identify messages when old transcripts omit image parts", () => {
  const claude = { ...delivery, agentId: "claude", imageCount: 1 };
  const history = {
    id: "new",
    items: [{ id: "new", type: "userMessage", text: delivery.text }],
  };
  assert.deepEqual(
    visibleMessageDeliveries([claude], { ...thread, agentId: "claude" }, [
      history,
    ]),
    [],
  );
});
