import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldKeepLoadedThread,
  shouldSurfaceThreadLoadError,
} from "./thread-load.ts";

test("thread load errors stay silent when turns are already on screen", () => {
  assert.equal(shouldSurfaceThreadLoadError({ turns: [{ id: "t1" }] }), false);
  assert.equal(shouldSurfaceThreadLoadError({ turns: [] }), true);
  assert.equal(shouldSurfaceThreadLoadError({}), true);
  assert.equal(shouldSurfaceThreadLoadError(undefined), true);
});

test("an empty in-progress response does not erase a cached transcript", () => {
  assert.equal(
    shouldKeepLoadedThread({ turns: [{ id: "previous" }] }, { turns: [] }),
    true,
  );
  assert.equal(shouldKeepLoadedThread({ turns: [] }, { turns: [] }), false);
  assert.equal(
    shouldKeepLoadedThread(
      { turns: [{ id: "previous" }] },
      { turns: [{ id: "next" }] },
    ),
    false,
  );
});
