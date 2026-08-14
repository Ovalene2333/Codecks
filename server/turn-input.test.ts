import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnInput,
  reviewParams,
} from "./turn-input.js";

test("buildTurnInput keeps text and pasted images", () => {
  const input = buildTurnInput("看图", [
    { url: "data:image/jpeg;base64,abc=" },
  ]);
  assert.deepEqual(input, [
    { type: "text", text: "看图", text_elements: [] },
    { type: "image", url: "data:image/jpeg;base64,abc=" },
  ]);
});

test("buildTurnInput rejects remote image URLs", () => {
  assert.throws(
    () => buildTurnInput("", [{ url: "https://example.com/a.png" }]),
    /本地图片/,
  );
});

test("reviewParams defaults to uncommitted changes", () => {
  assert.deepEqual(reviewParams("thr_1"), {
    threadId: "thr_1",
    delivery: "inline",
    target: { type: "uncommittedChanges" },
  });
  assert.equal(
    reviewParams("thr_1", { type: "baseBranch", branch: "main" }).target.branch,
    "main",
  );
});
