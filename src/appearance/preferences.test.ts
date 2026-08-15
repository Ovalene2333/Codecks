import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAppearancePreferences,
  resolveAppearance,
} from "../appearance";

test("appearance preferences fall back for invalid stored values", () => {
  assert.deepEqual(normalizeAppearancePreferences(null), {
    theme: "system",
    motion: "system",
  });
  assert.deepEqual(
    normalizeAppearancePreferences({ theme: "light", motion: "turbo" }),
    { theme: "light", motion: "system" },
  );
});

test("appearance resolution follows or overrides system preferences", () => {
  assert.deepEqual(
    resolveAppearance({ theme: "system", motion: "system" }, true, true),
    { theme: "dark", motion: "off" },
  );
  assert.deepEqual(
    resolveAppearance({ theme: "light", motion: "on" }, true, true),
    { theme: "light", motion: "on" },
  );
  assert.deepEqual(
    resolveAppearance({ theme: "dark", motion: "off" }, false, false),
    { theme: "dark", motion: "off" },
  );
});
