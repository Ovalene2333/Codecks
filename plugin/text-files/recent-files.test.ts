import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetPath,
  movePath,
  parseRecentFiles,
  rememberFile,
} from "./recent-files.js";

test("recent files keep the newest canonical path first and cap the list", () => {
  const files = Array.from({ length: 12 }, (_, index) => `/work/${index}.txt`);
  assert.deepEqual(
    parseRecentFiles([...files, files[0], 42, ""]),
    files.slice(0, 10),
  );
  assert.deepEqual(rememberFile(files, files[2]).slice(0, 3), [
    files[2],
    files[0],
    files[1],
  ]);
});

test("renaming and removing files or directories updates their recent paths", () => {
  const unix = ["/work/docs/a.md", "/work/docs-extra/b.md"];
  assert.deepEqual(movePath(unix, "/work/docs", "/work/notes"), [
    "/work/notes/a.md",
    "/work/docs-extra/b.md",
  ]);
  assert.deepEqual(forgetPath(unix, "/work/docs"), ["/work/docs-extra/b.md"]);
  const windows = ["C:\\work\\docs\\a.md", "C:\\work\\docs-old\\b.md"];
  assert.deepEqual(movePath(windows, "C:\\work\\docs", "C:\\work\\notes"), [
    "C:\\work\\notes\\a.md",
    "C:\\work\\docs-old\\b.md",
  ]);
  assert.deepEqual(forgetPath(windows, "C:\\work\\docs"), [
    "C:\\work\\docs-old\\b.md",
  ]);
});
