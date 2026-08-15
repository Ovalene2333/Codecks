import test from "node:test";
import assert from "node:assert/strict";
import {
  changeKindLabel,
  displayCommand,
  displayText,
  distinctPreview,
  fmtTime,
  formatTokens,
  relativeTime,
  sessionKey,
  shortenPath,
  threadIsUnsent,
} from "./format";
import { userText } from "./session/TurnBlock";
import { userImageParts } from "./session/images";

test("sessionKey joins provider and thread id", () => {
  assert.equal(sessionKey({ providerId: "p", id: "t" }), "codex:p:t");
  assert.equal(
    sessionKey({ agentId: "claude", providerId: "p", id: "t" }),
    "claude:p:t",
  );
});

test("threadIsUnsent is true only before the first user message", () => {
  assert.equal(threadIsUnsent({ preview: "新会话", status: "idle" }), true);
  assert.equal(
    threadIsUnsent({ preview: "写一个文件", status: "idle" }),
    false,
  );
  assert.equal(
    threadIsUnsent({ preview: "新会话", tokenUsage: { used: 12 } }),
    false,
  );
  assert.equal(
    threadIsUnsent({ preview: "新会话", lastError: "failed" }),
    false,
  );
});

test("relativeTime treats missing timestamps as empty", () => {
  assert.equal(relativeTime(0), "");
});

test("fmtTime does not throw on invalid timestamps", () => {
  assert.equal(fmtTime(Number.NaN), "");
  assert.equal(fmtTime(Number.POSITIVE_INFINITY), "");
});

test("formatTokens switches units and groups large values", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_234), "1.23K");
  assert.equal(formatTokens(999_999), "1M");
  assert.equal(formatTokens(261_741_000), "261.74M");
  assert.equal(formatTokens(5_934_076_000), "5.93B");
  assert.equal(formatTokens(1_234_567_890_123), "1,234.57B");
  assert.equal(formatTokens(Number.NaN), "");
});

test("changeKindLabel reads Codex tagged file-change kinds", () => {
  assert.equal(changeKindLabel("add"), "add");
  assert.equal(changeKindLabel({ type: "update", movePath: null }), "update");
  assert.equal(changeKindLabel({ type: "delete" }), "delete");
  assert.equal(changeKindLabel(undefined), "修改");
});

test("displayText flattens strings, arrays, and text objects", () => {
  assert.equal(displayText("hello"), "hello");
  assert.equal(displayText({ text: "hi" }), "hi");
  assert.equal(displayText([{ text: "a" }, { text: "b" }]), "a\nb");
  assert.equal(displayText({ type: "text", text: "ok" }), "ok");
});

test("distinctPreview hides titles that are just truncated last messages", () => {
  assert.equal(distinctPreview("新会话", "新会话"), "");
  assert.equal(
    distinctPreview(
      "根据 D:\\Code\\pcd_editor 的内容，完...",
      "根据 D:\\Code\\pcd_editor 的内容，完善文档",
    ),
    "",
  );
  assert.equal(
    distinctPreview("文档整理", "请继续改 README"),
    "请继续改 README",
  );
});

test("displayCommand unwraps zsh -lc wrappers", () => {
  assert.equal(
    displayCommand("/usr/bin/zsh -lc 'npm run build'"),
    "npm run build",
  );
  assert.equal(displayCommand('zsh -lc "rg foo"'), "rg foo");
  assert.equal(
    displayCommand("/usr/bin/zsh -lc 'sed -n '1,240p' src/image_prompt.ts'"),
    "sed -n '1,240p' src/image_prompt.ts",
  );
  assert.equal(displayCommand("npm test"), "npm test");
});

test("shortenPath strips the project cwd prefix", () => {
  assert.equal(
    shortenPath("/mnt/d/code/app/src/ui.tsx", "/mnt/d/code/app"),
    "src/ui.tsx",
  );
  assert.equal(shortenPath("src/ui.tsx", "/mnt/d/code/app"), "src/ui.tsx");
});

test("userText does not assume content is an array of parts", () => {
  assert.equal(userText({ type: "userMessage", text: "plain" }), "plain");
  assert.equal(
    userText({
      type: "userMessage",
      content: [{ type: "text", text: "hello" }],
    }),
    "hello",
  );
  assert.equal(
    userText({ type: "userMessage", content: "legacy string" }),
    "legacy string",
  );
});

test("userImageParts reads data-url attachments from user messages", () => {
  assert.deepEqual(
    userImageParts({
      type: "userMessage",
      content: [
        { type: "text", text: "看图" },
        { type: "image", url: "data:image/png;base64,abc=" },
      ],
    }),
    [{ url: "data:image/png;base64,abc=", alt: undefined }],
  );
});
