import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireRuntimeLock,
  clearRuntimeLock,
  readRuntimeLock,
  RUNTIME_LOCK_FILE,
  updateRuntimeLock,
} from "./runtime-lock.js";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "deck-lock-"));
}

test("first acquire writes a lock for this process", () => {
  const dir = tempDir();
  const result = acquireRuntimeLock(dir, {
    pid: 42,
    port: 4174,
    useWsl: true,
  });
  assert.equal(result.status, "acquired");
  const lock = readRuntimeLock(dir);
  assert.equal(lock?.pid, 42);
  assert.equal(lock?.port, 4174);
  assert.equal(lock?.useWsl, true);
});

test("a live foreign pid blocks a second Deck", () => {
  const dir = tempDir();
  acquireRuntimeLock(dir, { pid: 7, port: 4174, useWsl: false });
  const result = acquireRuntimeLock(
    dir,
    { pid: 8, port: 4174, useWsl: false },
    { alive: (pid) => pid === 7 },
  );
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.lock.pid, 7);
});

test("a dead pid with a leftover child is killed then replaced", () => {
  const dir = tempDir();
  const killed: number[] = [];
  acquireRuntimeLock(dir, { pid: 7, port: 4174, useWsl: true });
  updateRuntimeLock(dir, { childPid: 99 }, 7);
  const result = acquireRuntimeLock(
    dir,
    { pid: 8, port: 4174, useWsl: true },
    {
      alive: (pid) => pid === 99,
      kill: (pid) => killed.push(pid),
    },
  );
  assert.equal(result.status, "acquired");
  if (result.status === "acquired")
    assert.equal(result.staleChildKilled, 99);
  assert.deepEqual(killed, [99]);
  assert.equal(readRuntimeLock(dir)?.pid, 8);
});

test("clear only removes the lock owned by the expected pid", () => {
  const dir = tempDir();
  acquireRuntimeLock(dir, { pid: 7, port: 4174, useWsl: false });
  clearRuntimeLock(dir, 8);
  assert.equal(readRuntimeLock(dir)?.pid, 7);
  clearRuntimeLock(dir, 7);
  assert.equal(readRuntimeLock(dir), undefined);
  assert.equal(
    readFileSync.length > 0 &&
      (() => {
        try {
          readFileSync(path.join(dir, RUNTIME_LOCK_FILE), "utf8");
          return true;
        } catch {
          return false;
        }
      })(),
    false,
  );
});
