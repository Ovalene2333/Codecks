import type { ComposerImage } from "./images";

export interface ComposerDraft {
  text: string;
  images: ComposerImage[];
}

const drafts = new Map<string, ComposerDraft>();
const emptyDraft = (): ComposerDraft => ({ text: "", images: [] });

export function readComposerDraft(session: string): ComposerDraft {
  const draft = drafts.get(session);
  return draft ? { text: draft.text, images: [...draft.images] } : emptyDraft();
}

export function writeComposerDraft(session: string, draft: ComposerDraft) {
  const next = { text: draft.text, images: [...draft.images] };
  if (!next.text && !next.images.length) drafts.delete(session);
  else drafts.set(session, next);
  return next;
}

export function resetComposerDraftsForTests() {
  drafts.clear();
}
