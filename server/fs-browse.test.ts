import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDirectories } from "./fs-browse.js";

test("directory listing returns only directories and rejects files", async () => {
  const root = path.join(tmpdir(), `codex-deck-fs-${Date.now()}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".hidden"), { recursive: true });
  await writeFile(path.join(root, "readme.txt"), "hi");
  const listing = await listDirectories(root);
  assert.equal(listing.path, path.resolve(root));
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["src"],
  );
  await assert.rejects(listDirectories(path.join(root, "readme.txt")), /不是目录/);
});

test("null bytes are rejected", async () => {
  await assert.rejects(listDirectories("/tmp/\0oops"), /非法路径/);
});

test("windows empty path lists drive roots", async (t) => {
  if (process.platform !== "win32") {
    t.skip("windows only");
    return;
  }
  const listing = await listDirectories();
  assert.equal(listing.path, "");
  assert.ok(listing.entries.some((entry) => /^[A-Z]:$/.test(entry.name)));
});
