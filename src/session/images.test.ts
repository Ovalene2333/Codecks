import test from "node:test";
import assert from "node:assert/strict";
import { assistantImageParts, userImageParts } from "./images";

test("assistantImageParts finds generated and referenced image fields", () => {
  assert.deepEqual(
    assistantImageParts({
      content: [
        { type: "output_image", image_url: "https://example.test/gen.png" },
        { type: "output_image", b64_json: "YQ==" },
      ],
      image_url: "https://example.test/gen.png",
    }),
    [
      { url: "https://example.test/gen.png" },
      { url: "data:image/png;base64,YQ==" },
    ],
  );
});

test("assistantImageParts finds current Codex image view and generation items", () => {
  assert.deepEqual(
    assistantImageParts({
      items: [
        { type: "imageView", path: "/tmp/output/comparison.png" },
        {
          type: "imageGeneration",
          result: "data:image/png;base64,YQ==",
          savedPath: "/tmp/output/generated.png",
        },
      ],
    }),
    [
      { url: "/tmp/output/comparison.png" },
      { url: "/tmp/output/generated.png" },
    ],
  );
});

test("assistantImageParts ignores plain text outputs and non-image paths", () => {
  for (const item of [
    { type: "dynamicToolCall", tool: "playwright", output: "screenshot done" },
    { type: "commandExecution", command: "npm test", output: "all green" },
    { type: "mcpToolCall", result: "ok" },
    { type: "dynamicToolCall", output: "Wrote file /tmp/out.png" },
    { type: "webSearch", url: "https://example.com/article" },
    { type: "fileChange", data: { path: "/work/src/app.ts" } },
    { type: "unknown", items: [{ path: "/tmp/report.md" }] },
  ])
    assert.deepEqual(assistantImageParts(item), []);
});

test("assistantImageParts still accepts nested image payloads", () => {
  assert.deepEqual(
    assistantImageParts({ type: "dynamicToolCall", output: "/tmp/shot.png" }),
    [{ url: "/tmp/shot.png" }],
  );
  assert.deepEqual(
    assistantImageParts({
      type: "mcpToolCall",
      result: { savedPath: "C:\\shots\\view.jpg" },
    }),
    [{ url: "C:\\shots\\view.jpg" }],
  );
  assert.deepEqual(
    assistantImageParts({ data: "https://cdn.test/i/photo.avif?x=1" }),
    [{ url: "https://cdn.test/i/photo.avif?x=1" }],
  );
});

test("userImageParts keeps local image history compatible", () => {
  assert.deepEqual(
    userImageParts({
      content: [
        { type: "image", url: "data:image/png;base64,YQ==" },
        { type: "localImage", path: "/tmp/private.png", name: "private.png" },
      ],
    }),
    [
      { url: "data:image/png;base64,YQ==" },
      { url: "/tmp/private.png", alt: "private.png" },
    ],
  );
});
