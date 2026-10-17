import assert from "node:assert/strict";
import test from "node:test";
import {
  composerEnterAction,
  DEFAULT_DECK_SETTINGS,
  getDeckSettings,
  normalizeDeckSettings,
  normalizeInitialTurns,
  normalizeSidebarWidth,
  resetDeckSettings,
  updateDeckSettings,
} from "./deck-settings.js";

const enter = (init: Partial<KeyboardEvent> = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...init,
});

test("normalizeDeckSettings falls back to defaults for junk input", () => {
  assert.deepEqual(normalizeDeckSettings(undefined), DEFAULT_DECK_SETTINGS);
  assert.deepEqual(normalizeDeckSettings(null), DEFAULT_DECK_SETTINGS);
  assert.deepEqual(normalizeDeckSettings("x"), DEFAULT_DECK_SETTINGS);
  assert.deepEqual(normalizeDeckSettings(42), DEFAULT_DECK_SETTINGS);
});

test("normalizeDeckSettings keeps valid values and rejects invalid ones", () => {
  const next = normalizeDeckSettings({
    sendKey: "mod-enter",
    readingSize: "lg",
    notifyApprovals: false,
    notifyReplies: true,
    notifyOnlyHidden: true,
    hiddenTools: ["git", "terminal"],
    toolOpenTarget: "inline",
    sidebarWidth: 260,
  });
  assert.deepEqual(next, {
    sendKey: "mod-enter",
    readingSize: "lg",
    messageTypography: {
      ...DEFAULT_DECK_SETTINGS.messageTypography,
      fontSize: 17,
    },
    messageTemplates: [],
    notifyApprovals: false,
    notifyReplies: true,
    notifyOnlyHidden: true,
    hiddenTools: ["git", "terminal"],
    toolOpenTarget: "inline",
    sidebarWidth: 260,
    initialTurns: 10,
  });

  const mixed = normalizeDeckSettings({
    sendKey: "tab",
    readingSize: "xxl",
    notifyApprovals: "yes",
    toolOpenTarget: "window",
    hiddenTools: "git",
  });
  assert.equal(mixed.sendKey, DEFAULT_DECK_SETTINGS.sendKey);
  assert.equal(mixed.readingSize, DEFAULT_DECK_SETTINGS.readingSize);
  assert.equal(mixed.notifyApprovals, DEFAULT_DECK_SETTINGS.notifyApprovals);
  assert.equal(mixed.toolOpenTarget, DEFAULT_DECK_SETTINGS.toolOpenTarget);
  assert.deepEqual(mixed.hiddenTools, DEFAULT_DECK_SETTINGS.hiddenTools);
  assert.equal(mixed.sidebarWidth, 0);
});

test("normalizeInitialTurns clamps to the usable range", () => {
  assert.equal(normalizeInitialTurns(undefined), 10);
  assert.equal(normalizeInitialTurns("20" as never), 10);
  assert.equal(normalizeInitialTurns(Number.NaN), 10);
  assert.equal(normalizeInitialTurns(4.4), 5);
  assert.equal(normalizeInitialTurns(20), 20);
  assert.equal(normalizeInitialTurns(900), 100);
  assert.equal(normalizeDeckSettings({ initialTurns: 20 }).initialTurns, 20);
  assert.equal(normalizeDeckSettings({}).initialTurns, 10);
});

test("normalizeSidebarWidth clamps to the usable range", () => {
  assert.equal(normalizeSidebarWidth(0), 0);
  assert.equal(normalizeSidebarWidth(-40), 0);
  assert.equal(normalizeSidebarWidth(Number.NaN), 0);
  assert.equal(normalizeSidebarWidth("300" as never), 0);
  assert.equal(normalizeSidebarWidth(239.4), 240);
  assert.equal(normalizeSidebarWidth(300), 300);
  assert.equal(normalizeSidebarWidth(900), 480);
  assert.equal(normalizeDeckSettings({ sidebarWidth: 900 }).sidebarWidth, 480);
});

test("old reading sizes migrate without overriding explicit message typography", () => {
  assert.equal(
    normalizeDeckSettings({ readingSize: "sm" }).messageTypography.fontSize,
    13.5,
  );
  assert.equal(
    normalizeDeckSettings({
      readingSize: "lg",
      messageTypography: { fontSize: 18 },
    }).messageTypography.fontSize,
    18,
  );
});

test("normalizeDeckSettings dedupes hiddenTools and drops non-strings", () => {
  const next = normalizeDeckSettings({
    hiddenTools: ["git", "git", 7, null, "terminal", ""],
  });
  assert.deepEqual(next.hiddenTools, ["git", "terminal", ""]);
});

test("updateDeckSettings patches the store and reset restores defaults", () => {
  resetDeckSettings();
  updateDeckSettings({ sendKey: "mod-enter" });
  assert.equal(getDeckSettings().sendKey, "mod-enter");
  updateDeckSettings({ hiddenTools: ["git"] });
  assert.deepEqual(getDeckSettings().hiddenTools, ["git"]);
  assert.equal(getDeckSettings().sendKey, "mod-enter");
  resetDeckSettings();
  assert.deepEqual(getDeckSettings(), DEFAULT_DECK_SETTINGS);
});

test("composerEnterAction ignores keys other than Enter", () => {
  assert.equal(composerEnterAction(enter({ key: "a" }), "enter"), "none");
  assert.equal(
    composerEnterAction(enter({ key: "Escape" }), "mod-enter"),
    "none",
  );
});

test("composerEnterAction in enter mode sends on Enter, newline on Shift/Alt", () => {
  assert.equal(composerEnterAction(enter(), "enter"), "send");
  assert.equal(
    composerEnterAction(enter({ shiftKey: true }), "enter"),
    "newline",
  );
  assert.equal(
    composerEnterAction(enter({ altKey: true }), "enter"),
    "newline",
  );
  // 修饰键不改变 enter 模式的发送语义
  assert.equal(composerEnterAction(enter({ ctrlKey: true }), "enter"), "send");
  assert.equal(composerEnterAction(enter({ metaKey: true }), "enter"), "send");
});

test("composerEnterAction in mod-enter mode sends only with Ctrl/Cmd", () => {
  assert.equal(composerEnterAction(enter(), "mod-enter"), "newline");
  assert.equal(
    composerEnterAction(enter({ shiftKey: true }), "mod-enter"),
    "newline",
  );
  assert.equal(
    composerEnterAction(enter({ ctrlKey: true }), "mod-enter"),
    "send",
  );
  assert.equal(
    composerEnterAction(enter({ metaKey: true }), "mod-enter"),
    "send",
  );
  assert.equal(
    composerEnterAction(enter({ altKey: true }), "mod-enter"),
    "newline",
  );
});
