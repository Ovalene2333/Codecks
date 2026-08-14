import test from "node:test";
import assert from "node:assert/strict";
import { shouldSurfaceThreadLoadError } from "./thread-load.ts";

test("thread load errors stay silent when turns are already on screen", () => {
  assert.equal(shouldSurfaceThreadLoadError({ turns: [{ id: "t1" }] }), false);
  assert.equal(shouldSurfaceThreadLoadError({ turns: [] }), true);
  assert.equal(shouldSurfaceThreadLoadError({}), true);
  assert.equal(shouldSurfaceThreadLoadError(undefined), true);
});
