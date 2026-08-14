import test from "node:test";
import assert from "node:assert/strict";
import {
  readComposerDraft,
  resetComposerDraftsForTests,
  writeComposerDraft,
} from "./drafts.ts";

test("composer drafts stay isolated by session", () => {
  resetComposerDraftsForTests();
  writeComposerDraft("official:a", { text: "会话 A", images: [] });
  writeComposerDraft("official:b", { text: "会话 B", images: [] });

  assert.equal(readComposerDraft("official:a").text, "会话 A");
  assert.equal(readComposerDraft("official:b").text, "会话 B");
});

test("empty composer drafts are cleared", () => {
  resetComposerDraftsForTests();
  writeComposerDraft("official:a", { text: "草稿", images: [] });
  writeComposerDraft("official:a", { text: "", images: [] });
  assert.deepEqual(readComposerDraft("official:a"), { text: "", images: [] });
});
