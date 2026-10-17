import assert from "node:assert/strict";
import test from "node:test";
import { deckEscapeAction } from "./shortcuts.js";

const base = {
  overlay: 0,
  inTerminal: false,
  editableFocused: false,
  atHome: false,
};

test("Esc peels the top overlay before anything else", () => {
  assert.equal(
    deckEscapeAction({
      ...base,
      overlay: 3,
      editableFocused: true,
    }),
    "overlay",
  );
});

test("Esc inside the terminal is left for the shell", () => {
  assert.equal(
    deckEscapeAction({ ...base, inTerminal: true, editableFocused: true }),
    "none",
  );
});

test("Esc blurs a focused input before leaving the page", () => {
  assert.equal(
    deckEscapeAction({ ...base, editableFocused: true }),
    "blur",
  );
});

test("Esc goes home from non-home pages and rests at home", () => {
  assert.equal(deckEscapeAction(base), "home");
  assert.equal(deckEscapeAction({ ...base, atHome: true }), "none");
});
