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

test("user message text strips injected agent context blocks", () => {
  assert.equal(
    userMessageText({
      content: [
        { type: "text", text: "真正的提问" },
        {
          type: "text",
          text: "<system-reminder>\nDo not leak.\n</system-reminder>",
        },
      ],
    }),
    "真正的提问",
  );
  // 注入块与正文在同一 part 里内联出现时也要剥掉。
  assert.equal(
    userMessageText({
      content: [
        {
          type: "text",
          text: "<environment_context>\n<cwd>/work</cwd>\n</environment_context>\n\n查一下状态",
        },
      ],
    }),
    "查一下状态",
  );
  // Codex 首轮注入的 AGENTS.md 块。
  assert.equal(
    userMessageText({
      content: [
        {
          type: "text",
          text: "# AGENTS.md instructions for /work/x\n\n<INSTRUCTIONS>\n整份文件\n</INSTRUCTIONS>\n\n做这件事",
        },
      ],
    }),
    "做这件事",
  );
  // 整条全是注入内容 / 中断回显 → 空串（气泡整体隐藏）。
  assert.equal(
    userMessageText({
      content: [
        { type: "text", text: "[Request interrupted by user for tool use]" },
      ],
    }),
    "",
  );
  assert.equal(
    userMessageText({
      content: [
        {
          type: "text",
          text: "<task-notification>\n任务完成\n</task-notification>",
        },
      ],
    }),
    "",
  );
  // 普通文本与用户自己写的标签不受影响。
  assert.equal(
    userMessageText({
      content: [{ type: "text", text: "看看 <b>x</b> 标签" }],
    }),
    "看看 <b>x</b> 标签",
  );
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
