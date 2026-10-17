import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { referencedThreadImages, resolveThreadImage } from "./thread-image.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "deck-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const image = path.join(cwd, "demo image.png");
  const outside = path.join(root, "outside.png");
  await Promise.all([writeFile(image, "image"), writeFile(outside, "image")]);
  return { cwd, image, outside };
}

test("thread images resolve absolute paths, file URLs and paths relative to the session cwd", async (t) => {
  const { cwd, image } = await fixture(t);
  for (const value of [image, pathToFileURL(image).href, "demo image.png"])
    assert.equal(await resolveThreadImage(cwd, value), await realpath(image));
});

test("external thread images require an exact structured image reference", async (t) => {
  const { cwd, outside } = await fixture(t);
  await assert.rejects(resolveThreadImage(cwd, outside), /工作目录/);
  const full = {
    turns: [
      {
        items: [
          { type: "imageView", path: pathToFileURL(outside).href },
          { type: "commandExecution", path: "/tmp/demo-secret.png" },
          { type: "agentMessage", text: "/tmp/demo-secret.png" },
        ],
      },
    ],
  };
  const references = referencedThreadImages(full);
  assert.deepEqual(references, [pathToFileURL(outside).href]);
  assert.equal(
    await resolveThreadImage(cwd, outside, async () => references),
    await realpath(outside),
  );
  await assert.rejects(
    resolveThreadImage(cwd, outside, async () => ["/tmp/demo-missing.png"]),
    /引用/,
  );
});

test("image authorization follows real paths and rejects unsupported files", async (t) => {
  const { cwd, outside } = await fixture(t);
  const link = path.join(cwd, "link.png");
  try {
    await symlink(outside, link);
    await assert.rejects(resolveThreadImage(cwd, link), /工作目录/);
  } catch (error: any) {
    if (error.code !== "EPERM") throw error;
    t.diagnostic("当前环境没有创建文件符号链接的权限，跳过该项核对");
  }
  const text = path.join(cwd, "demo.txt");
  await writeFile(text, "demo");
  await assert.rejects(resolveThreadImage(cwd, text), /格式/);
});
