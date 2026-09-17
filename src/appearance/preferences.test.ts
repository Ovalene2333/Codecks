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
    effects: "on",
  });
  assert.deepEqual(
    normalizeAppearancePreferences({
      theme: "light",
      motion: "turbo",
      effects: "blur",
    }),
    { theme: "light", motion: "system", effects: "on" },
  );
  assert.deepEqual(
    normalizeAppearancePreferences({ effects: "off" }),
    { theme: "system", motion: "system", effects: "off" },
  );
});

test("appearance resolution follows or overrides system preferences", () => {
  assert.deepEqual(
    resolveAppearance(
      { theme: "system", motion: "system", effects: "on" },
      true,
      true,
    ),
    { theme: "dark", motion: "off", effects: "on" },
  );
  assert.deepEqual(
    resolveAppearance(
      { theme: "light", motion: "on", effects: "off" },
      true,
      true,
    ),
    { theme: "light", motion: "on", effects: "off" },
  );
  assert.deepEqual(
    resolveAppearance(
      { theme: "dark", motion: "off", effects: "off" },
      false,
      false,
    ),
    { theme: "dark", motion: "off", effects: "off" },
  );
});
