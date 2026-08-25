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
