import assert from "node:assert/strict";
import test from "node:test";
import {
  ASIDE_PANELS,
  DEFAULT_LAYOUT,
  MAIN_PANELS,
  isDefaultLayout,
  moveItem,
  normalizeOrder,
  parseLayout,
} from "./layout";

test("normalizeOrder keeps saved order, drops unknown and duplicate ids", () => {
  assert.deepEqual(
    normalizeOrder(["watch", "bogus", "recent", "watch", 3], MAIN_PANELS),
    ["watch", "recent", "attention", "unseen", "running"],
  );
});

test("normalizeOrder appends panels missing from the saved order", () => {
  assert.deepEqual(normalizeOrder(["health"], ASIDE_PANELS), ["health", "usage"]);
  assert.deepEqual(normalizeOrder("nope", ASIDE_PANELS), ["usage", "health"]);
});

test("moveItem moves forward and backward and clamps out-of-range targets", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(moveItem(list, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveItem(list, 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(moveItem(list, 1, 99), ["a", "c", "d", "b"]);
  assert.deepEqual(moveItem(list, 2, -5), ["c", "a", "b", "d"]);
  assert.deepEqual(moveItem(list, 7, 0), list);
  assert.deepEqual(list, ["a", "b", "c", "d"], "input is not mutated");
});

test("parseLayout falls back to defaults on missing or corrupt storage", () => {
  assert.deepEqual(parseLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(parseLayout("{not json"), DEFAULT_LAYOUT);
  assert.deepEqual(parseLayout("[1,2]"), DEFAULT_LAYOUT);
  const saved = parseLayout(JSON.stringify({ main: ["watch"], aside: ["health", "usage"] }));
  assert.deepEqual(saved.main, ["watch", "attention", "unseen", "running", "recent"]);
  assert.deepEqual(saved.aside, ["health", "usage"]);
  assert.equal(isDefaultLayout(saved), false);
  assert.equal(isDefaultLayout(parseLayout(null)), true);
});
