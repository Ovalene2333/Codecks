import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveThreadImage } from "./thread-image.js";

test("thread image resolver permits image files below the thread cwd", async () => {
  const root = path.join(tmpdir(), `codex-deck-image-${Date.now()}`);
  const image = path.join(root, "output", "result.png");
  await mkdir(path.dirname(image), { recursive: true });
  await writeFile(image, "image");
  assert.equal(await resolveThreadImage(root, image), image);
});

test("thread image resolver rejects paths outside the thread cwd", async () => {
  const root = path.join(tmpdir(), `codex-deck-image-${Date.now()}`);
  const outside = path.join(tmpdir(), `codex-deck-image-${Date.now()}.png`);
  await mkdir(root, { recursive: true });
  await writeFile(outside, "image");
  await assert.rejects(resolveThreadImage(root, outside), /工作目录/);
});
