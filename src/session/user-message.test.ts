import test from "node:test";
import assert from "node:assert/strict";
import { draftFromUserMessage, userMessageText } from "./user-message.ts";

test("user message text joins text parts and ignores images", () => {
  const item = {
    content: [
      { type: "text", text: "第一段" },
      { type: "image", url: "data:image/png;base64,YQ==" },
      { type: "inputText", text: "第二段" },
    ],
  };
  assert.equal(userMessageText(item), "第一段\n第二段");
});

test("history drafts only reuse safe inline images", () => {
  const item = {
    id: "user-1",
    content: [
      { type: "text", text: "再看一次" },
      { type: "image", url: "data:image/png;base64,YQ==", name: "safe.png" },
      { type: "localImage", path: "/tmp/private.png" },
    ],
  };
  assert.deepEqual(draftFromUserMessage(item), {
    draft: {
      text: "再看一次",
      images: [
        {
          id: "history-user-1-0",
          name: "safe.png",
          url: "data:image/png;base64,YQ==",
        },
      ],
    },
    skippedImages: 1,
  });
});
