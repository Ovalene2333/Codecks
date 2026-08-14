import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWslFsPath, listDirectories } from "./fs-browse.js";
import {
  listWslDirectories,
  parseWslDirListing,
  WSL_DIR_LIST_SCRIPT,
  wslDirListArgs,
} from "./fs-browse-wsl.js";

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

test("POSIX paths are treated as WSL filesystem targets", () => {
  assert.equal(isWslFsPath("/home/tester"), true);
  assert.equal(isWslFsPath("D:\\Code"), false);
  assert.equal(isWslFsPath(""), false);
});

test("useWsl lists POSIX paths through the WSL adapter", async () => {
  const listing = await listDirectories("/home/tester/proj", {
    useWsl: true,
    listWsl: async (target) => ({
      path: target,
      parent: "/home/tester",
      home: "/home/tester",
      entries: [{ name: "src", path: `${target}/src` }],
    }),
  });
  assert.equal(listing.path, "/home/tester/proj");
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["src"],
  );
});

test("useWsl still lists Windows paths on the host", async () => {
  const root = path.join(tmpdir(), `codex-deck-fs-win-${Date.now()}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  let called = false;
  const listing = await listDirectories(root, {
    useWsl: true,
    listWsl: async () => {
      called = true;
      throw new Error("should not list via WSL");
    },
  });
  assert.equal(called, false);
  assert.equal(listing.path, path.resolve(root));
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["src"],
  );
});

test("parseWslDirListing reads path parent home and children", () => {
  const listing = parseWslDirListing(
    "/home/tester/proj\n/home/tester\n/home/tester\ndocs\nsrc\n",
  );
  assert.equal(listing.path, "/home/tester/proj");
  assert.equal(listing.parent, "/home/tester");
  assert.equal(listing.home, "/home/tester");
  assert.deepEqual(
    listing.entries.map((entry) => entry.path),
    ["/home/tester/proj/docs", "/home/tester/proj/src"],
  );
});

test("parseWslDirListing treats / as having no parent", () => {
  const listing = parseWslDirListing("/\n\n/home/tester\nhome\nmnt\n");
  assert.equal(listing.path, "/");
  assert.equal(listing.parent, null);
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["home", "mnt"],
  );
});

test("wsl listing command passes the target as argv not a shell string", () => {
  const args = wslDirListArgs("/home/tester/proj");
  assert.equal(args[0], "--exec");
  assert.equal(args.at(-1), "/home/tester/proj");
  assert.equal(args.at(-2), "wsl-ls");
  assert.match(WSL_DIR_LIST_SCRIPT, /\$\{HOME:-\/\}/);
  assert.match(WSL_DIR_LIST_SCRIPT, /\$'\\n'/);
});

test("listWslDirectories maps adapter failures", async () => {
  await assert.rejects(
    listWslDirectories("/tmp", async () => {
      throw Object.assign(new Error("boom"), { stderr: "不是目录\n" });
    }),
    /不是目录/,
  );
});
