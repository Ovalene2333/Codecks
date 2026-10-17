import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectLocalAgentBins,
  probeLocalAgentBin,
} from "./local-agent-bins.js";

test("discovers distinct CLI versions from PATH and standard locations", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "deck-agent-bins-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const custom = path.join(home, "custom");
  const standard = path.join(home, ".opencode", "bin");
  await mkdir(custom);
  await mkdir(standard, { recursive: true });
  const name = process.platform === "win32" ? "opencode.exe" : "opencode";
  const first = path.join(custom, name);
  const second = path.join(standard, name);
  await writeFile(first, "#!/bin/sh\necho '1.2.3'\n");
  await writeFile(second, "#!/bin/sh\necho '2.0.0'\n");
  if (process.platform !== "win32") {
    await chmod(first, 0o755);
    await chmod(second, 0o755);
  }
  const items = collectLocalAgentBins(
    "opencode",
    second,
    { PATH: custom },
    process.platform,
    home,
  );
  assert.deepEqual(
    items.map((item) => item.bin),
    [first, second],
  );
  if (process.platform !== "win32") {
    assert.equal(await probeLocalAgentBin(first), "1.2.3");
    assert.equal(await probeLocalAgentBin(second), "2.0.0");
  }
});

test("saved CLI stays selectable without a duplicate PATH entry", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "deck-cli-alias-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(
    home,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  await writeFile(bin, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
  if (process.platform !== "win32") await chmod(bin, 0o755);
  assert.equal(
    collectLocalAgentBins(
      "claude",
      bin,
      { PATH: home },
      process.platform,
      home,
    ).filter((item) => item.bin === bin).length,
    1,
  );
  if (process.platform !== "win32")
    assert.equal(await probeLocalAgentBin(bin), "2.1.0");
});

test("Claude native installer versions appear separately from the current launcher", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "deck-native-versions-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, ".local", "share", "claude", "versions");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "2.0.0"), "placeholder");
  await writeFile(path.join(directory, "2.1.0"), "placeholder");
  if (process.platform !== "win32") {
    const launcher = path.join(home, ".local", "bin");
    await mkdir(launcher, { recursive: true });
    await symlink(path.join(directory, "2.1.0"), path.join(launcher, "claude"));
  }
  const bins = collectLocalAgentBins(
    "claude",
    "",
    { PATH: "" },
    process.platform,
    home,
  );
  assert.deepEqual(
    bins.map(({ bin }) => path.basename(bin)),
    [...(process.platform === "win32" ? [] : ["claude"]), "2.0.0", "2.1.0"],
  );
});

test("OpenCode discovers npm, native versions and V1/V2 command aliases outside PATH", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "deck-opencode-installs-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const name = process.platform === "win32" ? "opencode.cmd" : "opencode";
  const directories = [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".opencode", "desktop-ssh", "2.0.32"),
    path.join(home, ".nvm", "versions", "node", "v24.0.0", "bin"),
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), "placeholder");
  }
  const alias =
    process.platform === "win32" ? "opencode-v1.cmd" : "opencode-v1";
  await writeFile(path.join(directories[0], alias), "placeholder");
  const bins = collectLocalAgentBins(
    "opencode",
    "",
    { PATH: "" },
    process.platform,
    home,
  );
  for (const directory of directories)
    assert.ok(bins.some(({ bin }) => bin === path.join(directory, name)));
  assert.ok(bins.some(({ bin }) => bin === path.join(directories[0], alias)));
});

test(
  "OpenCode v-prefixed version output remains available in the runtime picker",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "deck-opencode-version-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = path.join(directory, "opencode");
    await writeFile(bin, "#!/bin/sh\necho 'opencode v2.0.32'\n");
    await chmod(bin, 0o755);
    assert.equal(await probeLocalAgentBin(bin), "2.0.32");
  },
);
