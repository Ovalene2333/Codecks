import assert from "node:assert/strict";
import test from "node:test";
import { branchInfo, branchRelations } from "./session-branch";
import type { ThreadSummary } from "./types";

function thread(id: string, forkedFromId?: string, updatedAt = 1): ThreadSummary {
  return {
    id,
    agentId: "codex",
    providerId: "acme",
    name: id,
    preview: "",
    cwd: "/work/demo",
    model: "demo",
    status: "idle",
    updatedAt,
    forkedFromId,
  };
}

test("branchRelations links forks to their parents and counts direct children", () => {
  const relations = branchRelations([
    thread("root"),
    thread("a", "root"),
    thread("b", "root"),
    thread("a1", "a"),
    thread("other"),
  ]);
  const root = branchInfo("codex:acme:root", relations);
  assert.equal(root.isBranch, false);
  assert.equal(root.depth, 0);
  assert.equal(root.childCount, 2);
  assert.equal(relations.get("codex:acme:a")?.parent, "codex:acme:root");
  assert.equal(relations.get("codex:acme:a")?.parentId, "root");
  assert.equal(branchInfo("codex:acme:a1", relations).depth, 2);
  assert.equal(branchInfo("codex:acme:a1", relations).childCount, 0);
  assert.equal(branchInfo("codex:acme:other", relations).isBranch, false);
});

test("branchRelations treats a missing parent as the visible root", () => {
  const relations = branchRelations([thread("orphan", "deleted-parent")]);
  const info = branchInfo("codex:acme:orphan", relations);
  assert.equal(info.isBranch, true);
  assert.equal(info.depth, 0);
  assert.equal(info.childCount, 0);
  assert.equal(relations.get("codex:acme:orphan")?.parent, undefined);
  assert.equal(relations.get("codex:acme:orphan")?.parentId, "deleted-parent");
});

test("branchRelations ignores cross-agent id matches and survives cycles", () => {
  const foreign = { ...thread("root"), agentId: "claude" as const };
  const relations = branchRelations([foreign, thread("child", "root")]);
  // 跨 agent 的同名 id 不建立父子关系：child 仍是分支，但按可见根处理。
  assert.equal(relations.get("codex:acme:child")?.parent, undefined);
  assert.equal(branchInfo("codex:acme:child", relations).depth, 0);

  const loop = branchRelations([thread("x", "y"), thread("y", "x")]);
  assert.ok(branchInfo("codex:acme:x", loop).depth >= 0);
  assert.ok(loop.get("codex:acme:y"));
});

test("branchRelations orders children by recent activity", () => {
  const relations = branchRelations([
    thread("root", undefined, 10),
    thread("old", "root", 5),
    thread("new", "root", 30),
  ]);
  assert.deepEqual(relations.get("codex:acme:root")?.children, [
    "codex:acme:new",
    "codex:acme:old",
  ]);
});
