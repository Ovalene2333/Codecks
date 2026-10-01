import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAcpAgentEntries, loadAcpAgentSpecs } from "./acp-agents.js";

async function withDataDir<T>(
  content: unknown,
  run: (dir: string) => Promise<T>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-acp-agents-"));
  try {
    await writeFile(path.join(dir, "acp-agents.json"), JSON.stringify(content));
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const specsFrom = (content: unknown) =>
  withDataDir(content, (dir) => loadAcpAgentSpecs(dir));

/** PATH 里只放指定的假命令，验证「是否已安装」的默认策略。 */
async function withBin<T>(
  commands: string[],
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
) {
  const bin = await mkdtemp(path.join(tmpdir(), "deck-bin-"));
  try {
    for (const name of commands) {
      const file = path.join(bin, name);
      await writeFile(file, "#!/bin/sh\nexit 0\n");
      await chmod(file, 0o755);
    }
    return await run({ PATH: bin });
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
}

test("fallbackFor marks a user-declared agent as the fallback of a primary agent", async () => {
  const specs = await specsFrom([
    {
      id: "claude-acp",
      name: "Claude (ACP)",
      command: "claude-code-acp",
      fallbackFor: " claude ",
    },
  ]);

  assert.equal(
    specs.find((spec) => spec.id === "claude-acp")?.fallbackFor,
    "claude",
  );
  // 内置 agent 默认都不是备选。
  assert.equal(
    specs.find((spec) => spec.id === "devin")?.fallbackFor,
    undefined,
  );
});

test("a user row only overrides the fields it actually writes", async () => {
  const specs = await specsFrom({
    // 没写 command/args：内置的启动参数必须原样保留。
    agents: [{ id: "devin", fallbackFor: "codex" }],
  });

  const devin = specs.find((spec) => spec.id === "devin");
  assert.equal(devin?.fallbackFor, "codex");
  assert.equal(devin?.command, "devin");
  assert.deepEqual(devin?.args, ["acp"]);
  assert.deepEqual(devin?.listSessions?.args, ["list", "--format", "json"]);
  assert.equal(devin?.name, "Devin");
});

test("fields the user does write replace the builtin ones", async () => {
  const specs = await specsFrom([
    {
      id: "devin",
      name: "My Devin",
      command: "/opt/devin/bin/devin",
      args: ["acp", "--verbose"],
      env: { DEVIN_HOME: "/opt/devin" },
    },
  ]);

  const devin = specs.find((spec) => spec.id === "devin");
  assert.equal(devin?.name, "My Devin");
  assert.equal(devin?.command, "/opt/devin/bin/devin");
  assert.deepEqual(devin?.args, ["acp", "--verbose"]);
  assert.deepEqual(devin?.env, { DEVIN_HOME: "/opt/devin" });
  assert.deepEqual(devin?.listSessions?.args, ["list", "--format", "json"]);
});

test("invalid fallbackFor values are ignored so no session gets hidden by mistake", async () => {
  const specs = await specsFrom([
    { id: "self", command: "x", fallbackFor: "self" },
    { id: "spaced", command: "x", fallbackFor: "Not A Valid Id!" },
    { id: "boolean", command: "x", fallbackFor: true },
    { id: "number", command: "x", fallbackFor: 42 },
    { id: "empty", command: "x", fallbackFor: "  " },
    { id: "absent", command: "x" },
  ]);

  for (const id of ["self", "spaced", "boolean", "number", "empty", "absent"]) {
    const spec = specs.find((item) => item.id === id);
    assert.ok(spec, `${id} should still be registered`);
    assert.equal(spec.fallbackFor, undefined, id);
  }
});

test("builtin agents whose command is missing default to not loaded", async () => {
  await withBin(["devin"], (env) =>
    withDataDir([], async (dir) => {
      const entries = await loadAcpAgentEntries(dir, env);
      const byId = new Map(entries.map((entry) => [entry.spec.id, entry]));

      assert.equal(byId.get("devin")?.defaultEnabled, true);
      assert.equal(byId.get("devin")?.defaultNote, undefined);
      for (const id of ["kimi", "goose", "copilot", "droid"]) {
        const entry = byId.get(id);
        assert.equal(entry?.builtin, true, id);
        assert.equal(entry?.defaultEnabled, false, id);
        assert.equal(
          entry?.defaultNote,
          `未检测到 ${entry?.spec.command} 命令`,
        );
      }
    }),
  );
});

test("installing a builtin agent's command flips its default to loaded", async () => {
  await withBin(["kimi"], (env) =>
    withDataDir([], async (dir) => {
      const entries = await loadAcpAgentEntries(dir, env);
      assert.equal(
        entries.find((entry) => entry.spec.id === "kimi")?.defaultEnabled,
        true,
      );
    }),
  );
});

test("the launch command is looked up with the agent's own env, not just ours", async () => {
  await withBin(["kimi"], (env) =>
    withDataDir(
      // 用户给 kimi 指了一个自带 PATH 的环境：以它为准。
      [{ id: "kimi", env: { PATH: env.PATH! } }],
      async (dir) => {
        const entries = await loadAcpAgentEntries(dir, {
          PATH: "/nonexistent",
        });
        assert.equal(
          entries.find((entry) => entry.spec.id === "kimi")?.defaultEnabled,
          true,
        );
      },
    ),
  );
});

test("explicit enabled in acp-agents.json beats the installed check", async () => {
  await withBin([], (env) =>
    withDataDir(
      [
        // 没装也显式要求加载；能只写 id + enabled，不必重复 command。
        { id: "kimi", enabled: true },
        { id: "devin", enabled: false },
      ],
      async (dir) => {
        const entries = await loadAcpAgentEntries(dir, env);
        const byId = new Map(entries.map((entry) => [entry.spec.id, entry]));
        assert.equal(byId.get("kimi")?.defaultEnabled, true);
        assert.equal(byId.get("devin")?.defaultEnabled, false);
        assert.match(byId.get("devin")?.defaultNote || "", /enabled: false/);
        // 兼容入口不返回被显式停用的。
        const specs = await loadAcpAgentSpecs(dir);
        assert.ok(!specs.some((spec) => spec.id === "devin"));
      },
    ),
  );
});

test("user-declared agents default to loaded even when their command is missing", async () => {
  await withBin([], (env) =>
    withDataDir(
      [{ id: "my-agent", name: "My Agent", command: "no-such-cli" }],
      async (dir) => {
        const entries = await loadAcpAgentEntries(dir, env);
        const mine = entries.find((entry) => entry.spec.id === "my-agent");
        assert.equal(mine?.builtin, false);
        assert.equal(mine?.defaultEnabled, true);
      },
    ),
  );
});

test("a data dir without acp-agents.json still lists the builtin agents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-acp-empty-"));
  try {
    await mkdir(dir, { recursive: true });
    const entries = await loadAcpAgentEntries(dir, { PATH: "" });
    assert.deepEqual(
      entries.map((entry) => entry.spec.id),
      ["devin", "kimi", "goose", "copilot", "droid"],
    );
    assert.ok(entries.every((entry) => !entry.defaultEnabled));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
