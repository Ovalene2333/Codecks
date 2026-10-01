import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_READ_BYTES,
  parseWslListing,
  parseWslRead,
  TextFilesTool,
  wslListArgs,
  wslWriteArgs,
} from "./text-files.server.js";
import type { FsListing } from "./text-files.types.js";

test("WSL 列表参数与目录解析", () => {
  assert.deepEqual(wslListArgs("/home/u").slice(0, 3), ["--exec", "sh", "-c"]);
  const listing = parseWslListing(
    "/home/u\n/home\n/home/u\nd\tdocs\nf\tb.txt\t128 1690000000\nf\ta.txt\t64 1690000001\n",
  );
  assert.equal(listing.path, "/home/u");
  assert.equal(listing.parent, "/home");
  assert.equal(listing.home, "/home/u");
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.kind]),
    [
      ["docs", "dir"],
      ["a.txt", "file"],
      ["b.txt", "file"],
    ],
  );
  assert.equal(listing.entries[1].size, 64);
  assert.equal(listing.entries[1].mtimeMs, 1_690_000_001_000);
});

test("WSL 读取解析：base64 内容、大小与二进制探测", () => {
  const content = "hello 文本\n";
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const file = parseWslRead(`11 1690000000\n${encoded}\n`, "/home/u/a.txt");
  assert.equal(file.content, content);
  assert.equal(file.size, 11);
  assert.equal(file.truncated, false);
  assert.equal(file.mtimeMs, 1_690_000_000_000);
  assert.throws(
    () =>
      parseWslRead(
        `4 1690000000\n${Buffer.from([0, 1, 2, 3]).toString("base64")}\n`,
        "/home/u/bin",
      ),
    /二进制文件/,
  );
  const truncated = parseWslRead(
    `${MAX_READ_BYTES + 10} 1690000000\n${Buffer.from("x").toString("base64")}\n`,
    "/home/u/big.log",
  );
  assert.equal(truncated.truncated, true);
});

test("list 返回目录与文件并按目录优先排序", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "zdir"));
  await mkdir(path.join(dir, "adir"));
  await writeFile(path.join(dir, "b.txt"), "b");
  await writeFile(path.join(dir, ".env"), "secret");
  const tool = new TextFilesTool();
  const listing = (await tool.run({
    action: "list",
    path: dir,
  })) as FsListing;
  assert.equal(listing.path, dir);
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["adir", "zdir", ".env", "b.txt"],
  );
  assert.equal(listing.entries[0].kind, "dir");
  assert.equal(listing.entries[2].kind, "file");
  assert.equal(listing.entries[3].size, 1);
  assert.ok(listing.entries[3].mtimeMs);
});

test("list 拒绝非目录路径", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "a.txt");
  await writeFile(file, "x");
  const tool = new TextFilesTool();
  await assert.rejects(tool.run({ action: "list", path: file }), /不是目录/);
});

test("read 返回文本内容并拒绝二进制文件", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "note.md");
  await writeFile(file, "# 标题\n内容");
  const tool = new TextFilesTool();
  const doc = (await tool.run({ action: "read", path: file })) as any;
  assert.equal(doc.content, "# 标题\n内容");
  assert.equal(doc.truncated, false);
  assert.equal(doc.size, Buffer.byteLength("# 标题\n内容"));
  const bin = path.join(dir, "blob.bin");
  await writeFile(bin, Buffer.from([0x89, 0x50, 0x00, 0x47]));
  await assert.rejects(tool.run({ action: "read", path: bin }), /二进制文件/);
});

test("write 新建、覆盖与冲突检测", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = new TextFilesTool();
  const target = path.join(dir, "new.txt");
  const created = (await tool.run({
    action: "write",
    path: target,
    content: "第一版",
    create: true,
  })) as any;
  assert.equal(created.status, "saved");
  assert.equal(await readFile(target, "utf8"), "第一版");
  const conflict = (await tool.run({
    action: "write",
    path: target,
    content: "并发创建",
    create: true,
  })) as any;
  assert.equal(conflict.status, "conflict");
  const stale = (await tool.run({
    action: "write",
    path: target,
    content: "覆盖",
    baseMtimeMs: created.mtimeMs - 10_000,
  })) as any;
  assert.equal(stale.status, "conflict");
  const forced = (await tool.run({
    action: "write",
    path: target,
    content: "覆盖",
    baseMtimeMs: created.mtimeMs - 10_000,
    force: true,
  })) as any;
  assert.equal(forced.status, "saved");
  assert.equal(await readFile(target, "utf8"), "覆盖");
});

test("write 在父目录缺失时报错", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = new TextFilesTool();
  await assert.rejects(
    tool.run({
      action: "write",
      path: path.join(dir, "missing", "a.txt"),
      content: "x",
    }),
    /父目录不存在/,
  );
});

test("mkdir 与 remove：目录仅限空目录删除", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = new TextFilesTool();
  const sub = path.join(dir, "sub");
  await tool.run({ action: "mkdir", path: sub });
  await writeFile(path.join(sub, "f.txt"), "x");
  await assert.rejects(tool.run({ action: "remove", path: sub }), /目录非空/);
  await tool.run({ action: "remove", path: path.join(sub, "f.txt") });
  await tool.run({ action: "remove", path: sub });
  await assert.rejects(
    tool.run({ action: "list", path: sub }),
    /路径不存在|不存在/,
  );
});

test("rename 在同一目录内改名并拒绝非法名称", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "text-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = new TextFilesTool();
  const target = path.join(dir, "a.txt");
  await writeFile(target, "x");
  const result = (await tool.run({
    action: "rename",
    path: target,
    name: "b.txt",
  })) as any;
  assert.equal(result.path, path.join(dir, "b.txt"));
  assert.equal(await readFile(result.path, "utf8"), "x");
  await assert.rejects(
    tool.run({ action: "rename", path: result.path, name: "../x" }),
  );
  await assert.rejects(
    tool.run({ action: "rename", path: result.path, name: ".." }),
  );
});

test("write 通过 WSL 分支调用注入的执行器", async () => {
  const calls: string[][] = [];
  let written: [string, string, boolean] | undefined;
  const tool = new TextFilesTool({
    platform: "win32",
    useWsl: true,
    exec: async (_command, args) => {
      calls.push(args);
      if (args[1] === "stat") return { stdout: "1690000000 5\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    wslWrite: async (target, content, create) => {
      written = [target, content, create];
      return {
        status: "saved",
        path: target,
        size: content.length,
        mtimeMs: 1,
      };
    },
  });
  const result = (await tool.run({
    action: "write",
    path: "/home/u/a.txt",
    content: "abc",
    baseMtimeMs: 1_690_000_000_000,
  })) as any;
  assert.equal(result.status, "saved");
  assert.deepEqual(written, ["/home/u/a.txt", "abc", false]);
  assert.ok(calls.some((args) => args[1] === "stat"));
});

test("WSL 写入参数带 noclobber 标记", () => {
  const args = wslWriteArgs("/home/u/a.txt", true);
  assert.equal(args.at(-1), "create");
  assert.match(args[3], /set -C/);
});
