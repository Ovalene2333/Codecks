import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DeckRecipientError,
  resolveExplicitRecipient,
  type RecipientResolverDeps,
} from "./deck-recipients.js";

const deps = (over: Partial<RecipientResolverDeps> = {}): RecipientResolverDeps => ({
  findSessionByAlias: (alias) =>
    alias === "s-abc1234" ? { agentId: "codex", threadId: "t1" } : undefined,
  findAskByAlias: (alias) =>
    alias === "deadbeef" ? { alias, target: { agentId: "opencode", threadId: "t2" } } : undefined,
  findByWakeCode: (code) =>
    code === "wake1" ? { agentId: "codex", threadId: "t3" } : undefined,
  isArchived: (target) => target.threadId === "archived",
  ensureAlias: async () => "s-new0001",
  ...over,
});

test("resolves @s- session aliases and rejects unknown or archived sessions", async () => {
  const ok = await resolveExplicitRecipient({ to: "@s-abc1234" }, deps());
  assert.deepEqual(ok, { kind: "session", target: { agentId: "codex", threadId: "t1" }, alias: "s-abc1234" });
  await assert.rejects(resolveExplicitRecipient({ to: "@s-zzz9999" }, deps()), (error: any) => {
    assert.ok(error instanceof DeckRecipientError);
    assert.equal(error.code, "UNKNOWN_ALIAS");
    assert.equal(error.statusCode, 404);
    return true;
  });
  await assert.rejects(
    resolveExplicitRecipient({ to: "@s-abc1234" }, deps({ isArchived: () => true })), (error: any) => {
      assert.ok(error instanceof DeckRecipientError);
      assert.equal(error.code, "ARCHIVED");
      assert.equal(error.statusCode, 409);
      return true;
    });
});

test("resolves @ask aliases without leaking ledger internals", async () => {
  const ok = await resolveExplicitRecipient({ to: "@deadbeef" }, deps());
  assert.deepEqual(ok, { kind: "ask", target: { agentId: "opencode", threadId: "t2" }, alias: "deadbeef" });
  await assert.rejects(resolveExplicitRecipient({ to: "@nosuchask" }, deps()), (error: any) => {
    assert.equal(error.code, "UNKNOWN_ALIAS");
    assert.equal(error.statusCode, 404);
    return true;
  });
  await assert.rejects(
    resolveExplicitRecipient({ to: "@deadbeef" }, deps({ isArchived: () => true })), (error: any) => {
      assert.equal(error.code, "ARCHIVED");
      assert.equal(error.statusCode, 409);
      return true;
    });
});

test("resolves legacy wake codes and rejects unknown or archived bindings", async () => {
  const ok = await resolveExplicitRecipient({ code: "wake1" }, deps());
  assert.deepEqual(ok, { kind: "session", target: { agentId: "codex", threadId: "t3" } });
  await assert.rejects(resolveExplicitRecipient({ code: "nope" }, deps()), (error: any) => {
    assert.equal(error.code, "UNKNOWN_ALIAS");
    assert.equal(error.statusCode, 404);
    return true;
  });
  await assert.rejects(
    resolveExplicitRecipient({ code: "wake1" }, deps({ isArchived: () => true })), (error: any) => {
      assert.equal(error.code, "ARCHIVED");
      assert.equal(error.statusCode, 409);
      return true;
    });
});

test("resolves explicit agent:thread references and validates their shape", async () => {
  const ok = await resolveExplicitRecipient({ to: "opencode:ses_abc" }, deps());
  assert.deepEqual(ok, { kind: "session", target: { agentId: "opencode", threadId: "ses_abc" }, alias: "s-new0001" });
  for (const bad of ["@", "no-colon", ":thread", "codex:", "Codex!:t", ""])
    await assert.rejects(resolveExplicitRecipient({ to: bad }, deps()), (error: any) => {
      assert.equal(error.code, "BAD_FORMAT");
      assert.equal(error.statusCode, 400);
      return true;
    }, bad || "(empty)");
  // `@s-` 形状合法但查无此别名：走查找失败而非格式错误（CLI 侧另有格式校验）。
  await assert.rejects(resolveExplicitRecipient({ to: "@s-" }, deps()), (error: any) => {
    assert.equal(error.code, "UNKNOWN_ALIAS");
    assert.equal(error.statusCode, 404);
    return true;
  });
  await assert.rejects(
    resolveExplicitRecipient({ to: "codex:archived" }, deps({ isArchived: () => true })), (error: any) => {
      assert.equal(error.code, "ARCHIVED");
      assert.equal(error.statusCode, 409);
      return true;
    });
});

test("recipient errors carry only whitelisted candidate fields", () => {
  const error = new DeckRecipientError("AMBIGUOUS", 409, "ambiguous", [
    { agentId: "codex", threadId: "t1", alias: "a1", status: "running" },
  ]);
  assert.equal(error.code, "AMBIGUOUS");
  assert.equal(error.statusCode, 409);
  assert.deepEqual(Object.keys(error.candidates![0]).sort(), ["agentId", "alias", "status", "threadId"]);
});

test("send route keeps --to/--code mutual exclusion and honors recipient status codes", async () => {
  const server = await readFile("server/index.ts", "utf8");
  assert.match(server, /--to 与 --code 不能同时使用/);
  assert.match(server, /resolveExplicitRecipient\(input,/);
  // 路由错误包装器按 DeckRecipientError.statusCode 回状态码，404/409 才有意义。
  assert.match(server, /typeof error\?\.statusCode === "number"/);
});
