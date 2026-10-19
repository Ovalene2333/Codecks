import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitContextProbe } from "./git-context.js";

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    );
  });

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "deck-git-context-"));
  await git(root, ["init", "-q"]);
  await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["config", "user.email", "demo@example.com"]);
  await git(root, ["config", "user.name", "Demo"]);
  await writeFile(path.join(root, "a.txt"), "a\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "init"]);
  return root;
}

test("probe reports the current branch of a main checkout", async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await new GitContextProbe({ ttlMs: 0 }).probe(root);
  assert.equal(context.available, true);
  assert.equal(context.branch, "main");
  assert.equal(context.detached, false);
  assert.equal(context.linked, false);
});

test("probe marks a linked worktree and detached HEAD", async (t) => {
  const root = await repository();
  const target = `${root}-worktree`;
  t.after(async () => {
    await git(root, ["worktree", "remove", "--force", target]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
  await git(root, ["worktree", "add", "--detach", target]);
  const context = await new GitContextProbe({ ttlMs: 0 }).probe(target);
  assert.equal(context.available, true);
  assert.equal(context.linked, true);
  assert.equal(context.detached, true);
  assert.equal(context.branch, undefined);
});

test("probe degrades for non-repositories and missing cwd", async (t) => {
  const plain = await mkdtemp(path.join(tmpdir(), "deck-git-plain-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  const probe = new GitContextProbe({ ttlMs: 0 });
  assert.deepEqual(await probe.probe(plain), {
    available: false,
    reason: "not-repository",
  });
  assert.deepEqual(await probe.probe(""), { available: false, reason: "no-cwd" });
});
