import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorktreeStore, parseWorktreePorcelain } from "./worktrees.js";

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    );
  });

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "deck-worktree-repo-"));
  await git(root, ["init", "-q"]);
  // 老版本 git 没有 `init -b`，用 symbolic-ref 指定初始分支，兼容 CI。
  await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["config", "user.email", "demo@example.com"]);
  await git(root, ["config", "user.name", "Demo"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "init"]);
  await git(root, ["branch", "feature/demo"]);
  return root;
}

test("parseWorktreePorcelain reads paths, branches and detached state", () => {
  const entries = parseWorktreePorcelain(
    [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /data/worktrees/a",
      "HEAD def",
      "detached",
      "",
    ].join("\n"),
  );
  assert.deepEqual(entries, [
    { path: "/repo", branch: "main", detached: false },
    { path: "/data/worktrees/a", detached: true },
  ]);
});

test("worktree is created detached from the current commit and removed again", async (t) => {
  const root = await repository();
  const dataDir = await mkdtemp(path.join(tmpdir(), "deck-worktree-data-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const store = new WorktreeStore(dataDir);
  await store.load();
  const record = await store.create("thread-1", root);
  assert.equal(record.threadId, "thread-1");
  assert.ok(record.path.startsWith(path.join(dataDir, "worktrees")));
  const list = parseWorktreePorcelain(
    await git(root, ["worktree", "list", "--porcelain"]),
  );
  const created = list.find((entry) => entry.path === record.path);
  assert.ok(created);
  assert.equal(created.detached, true);
  assert.equal(await store.dirty(record), false);

  assert.deepEqual(await store.remove("thread-1"), { removed: true });
  assert.equal(store.get("thread-1"), undefined);
});

test("a dirty worktree is kept unless removal is forced", async (t) => {
  const root = await repository();
  const dataDir = await mkdtemp(path.join(tmpdir(), "deck-worktree-dirty-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const store = new WorktreeStore(dataDir);
  await store.load();
  const record = await store.create("thread-2", root);
  await writeFile(path.join(record.path, "untracked.txt"), "keep me");

  assert.deepEqual(await store.remove("thread-2"), { removed: false, reason: "dirty" });
  assert.ok(store.get("thread-2"));

  // 台账改挂后仍是同一条记录，删除会话时查得到。
  assert.equal(await store.rebind("thread-2", "thread-2b"), true);
  assert.ok(store.get("thread-2b"));
  assert.deepEqual(await store.remove("thread-2b", { force: true }), { removed: true });
});

test("a branch base is validated before creating the worktree", async (t) => {
  const root = await repository();
  const dataDir = await mkdtemp(path.join(tmpdir(), "deck-worktree-base-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const store = new WorktreeStore(dataDir);
  await store.load();
  await writeFile(path.join(root, "README.md"), "# newer main\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "advance main"]);
  const record = await store.create("thread-3", root, { base: "feature/demo" });
  const head = (await git(record.path, ["rev-parse", "HEAD"])).trim();
  const branch = (await git(root, ["rev-parse", "feature/demo"])).trim();
  assert.equal(head, branch);
  assert.equal(record.commit, branch);
  assert.notEqual(record.commit, (await git(root, ["rev-parse", "HEAD"])).trim());
  await assert.rejects(
    store.create("thread-4", root, { base: "-not-a-branch" }),
    /找不到分支或提交/,
  );
});

test("non-git directories and disabled runtimes are rejected", async (t) => {
  const plain = await mkdtemp(path.join(tmpdir(), "deck-worktree-plain-"));
  const dataDir = await mkdtemp(path.join(tmpdir(), "deck-worktree-off-"));
  t.after(async () => {
    await rm(plain, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(new WorktreeStore(dataDir).create("t", plain), /不是 Git 仓库/);
  const disabled = new WorktreeStore(dataDir, { enabled: false });
  await assert.rejects(disabled.create("t", plain), /不支持 worktree/);
});
