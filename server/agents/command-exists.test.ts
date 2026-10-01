import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandExists } from "./command-exists.js";

async function withDir<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-cmd-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("commandExists finds executables on PATH and ignores the rest", async () => {
  await withDir(async (dir) => {
    const exe = path.join(dir, "fake-cli");
    await writeFile(exe, "#!/bin/sh\n");
    await chmod(exe, 0o755);
    const plain = path.join(dir, "not-executable");
    await writeFile(plain, "data");
    await chmod(plain, 0o644);
    const env = { PATH: `/nonexistent${path.delimiter}${dir}` };

    assert.equal(commandExists("fake-cli", env, "linux"), true);
    // 没有可执行位的文件不是命令，spawn 也会 EACCES。
    assert.equal(commandExists("not-executable", env, "linux"), false);
    assert.equal(commandExists("missing-cli", env, "linux"), false);
    assert.equal(commandExists("fake-cli", { PATH: "" }, "linux"), false);
    assert.equal(commandExists("fake-cli", {}, "linux"), false);
  });
});

test("commandExists handles explicit paths and rejects junk input", async () => {
  await withDir(async (dir) => {
    const exe = path.join(dir, "fake-cli");
    await writeFile(exe, "#!/bin/sh\n");
    await chmod(exe, 0o755);

    assert.equal(commandExists(exe, {}, "linux"), true);
    assert.equal(commandExists(path.join(dir, "nope"), {}, "linux"), false);
    // 目录不是命令。
    assert.equal(commandExists(dir, {}, "linux"), false);
    assert.equal(commandExists("", {}, "linux"), false);
    assert.equal(commandExists("  ", {}, "linux"), false);
    assert.equal(commandExists("bad\ncommand", {}, "linux"), false);
  });
});

test("commandExists tries PATHEXT suffixes on Windows (npm .cmd shims count)", async () => {
  await withDir(async (dir) => {
    // 文件名大小写与 PATHEXT 保持一致：真 Windows 不区分大小写，这里的 Linux 区分。
    await writeFile(path.join(dir, "kimi.CMD"), "@echo off\r\n");
    await writeFile(path.join(dir, "goose.EXE"), "MZ");
    // Windows 不看可执行位，只看后缀补全；环境变量名 Path 与 PATH 都认。
    const env = { Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    assert.equal(commandExists("goose", env, "win32"), true);
    assert.equal(commandExists("kimi", env, "win32"), true);
    assert.equal(commandExists("copilot", env, "win32"), false);
    assert.equal(
      commandExists("kimi", { PATH: dir, PATHEXT: ".EXE" }, "win32"),
      false,
    );
    // 没有 PATHEXT 时退回 Windows 默认后缀表。
    assert.equal(commandExists("kimi", { Path: dir }, "win32"), true);
  });
});
