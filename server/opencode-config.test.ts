import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openCodeGlobalDir,
  allowOpenCodeExternalDirectories,
  deleteOpenCodeProvider,
  parseJsonc,
  parseOpenCodeProviders,
  readOpenCodeConfig,
  readOpenCodePermissions,
  upsertOpenCodeProvider,
  writeOpenCodeConfig,
  writeOpenCodePermission,
} from "./opencode-config.js";

test("parseJsonc strips comments and trailing commas but keeps URLs", () => {
  const parsed = parseJsonc(`{
    // line comment
    "provider": { "x": { "options": { "baseURL": "https://a.b/v1" } }, },
    /* block
       comment */
    "model": "acme/claude-opus-5-5",
  }`);
  assert.equal(parsed.model, "acme/claude-opus-5-5");
  assert.equal(parsed.provider.x.options.baseURL, "https://a.b/v1");
});

test("readOpenCodeConfig prefers opencode.json and tolerates jsonc", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-config-"));
  await writeFile(
    path.join(dir, "opencode.jsonc"),
    '{ // hi\n "agent": { "explore": { "disable": true } } }\n',
  );
  const file = await readOpenCodeConfig("project", dir);
  assert.equal(file.exists, true);
  assert.equal(file.path, path.join(dir, "opencode.jsonc"));
  assert.equal(file.config.agent.explore.disable, true);
});

test("writeOpenCodeConfig creates a file and merges agent patches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-config-"));
  const file = await writeOpenCodeConfig("project", dir, {
    agent: { explore: { model: "demo/claude-haiku-4-5", disable: false } },
    model: "acme/claude-opus-5-5",
    smallModel: "demo/claude-haiku-4-5",
  });
  assert.equal(file.path, path.join(dir, "opencode.json"));
  const written = JSON.parse(await readFile(file.path, "utf8"));
  assert.equal(written.$schema, "https://opencode.ai/config.json");
  assert.equal(written.model, "acme/claude-opus-5-5");
  assert.equal(written.small_model, "demo/claude-haiku-4-5");
  assert.equal(written.agent.explore.model, "demo/claude-haiku-4-5");
  assert.equal(written.agent.explore.disable, undefined);
});

test("writeOpenCodeConfig null deletes keys and preserves unrelated config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-config-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      provider: { acme: { options: { apiKey: "k" } } },
      agent: { explore: { model: "a/b", disable: true }, other: { model: "c" } },
    }),
  );
  await writeOpenCodeConfig("project", dir, {
    agent: { explore: { model: null, disable: false } },
  });
  const written = JSON.parse(
    await readFile(path.join(dir, "opencode.json"), "utf8"),
  );
  assert.equal(written.provider.acme.options.apiKey, "k");
  assert.deepEqual(written.agent.explore, undefined);
  assert.deepEqual(written.agent.other, { model: "c" });
});

test("project scope without directory is rejected", async () => {
  await assert.rejects(() => readOpenCodeConfig("project"), /必须提供目录/);
});

test("openCodeGlobalDir prefers OPENCODE_CONFIG_DIR over XDG and home", () => {
  assert.equal(
    openCodeGlobalDir(
      { OPENCODE_CONFIG_DIR: "/shared/oc", XDG_CONFIG_HOME: "/xdg" },
      "/home/u",
    ),
    path.resolve("/shared/oc"),
  );
});

test("openCodeGlobalDir falls back to XDG_CONFIG_HOME then home", () => {
  assert.equal(
    openCodeGlobalDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"),
    path.join("/xdg", "opencode"),
  );
  assert.equal(
    openCodeGlobalDir({}, "/home/u"),
    path.join("/home/u", ".config", "opencode"),
  );
});

test("external directory grants persist per project without widening existing rules", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-permission-"));
  await writeFile(path.join(dir, "opencode.json"), JSON.stringify({
    permission: { external_directory: { "*": "ask", "/opt/demo/private/*": "deny" }, bash: "ask" },
  }));
  await allowOpenCodeExternalDirectories(dir, ["/opt/demo/assets/*"]);
  const config = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(config.permission, {
    external_directory: { "*": "ask", "/opt/demo/private/*": "deny", "/opt/demo/assets/*": "allow" },
    bash: "ask",
  });
  await assert.rejects(() => allowOpenCodeExternalDirectories(dir, ["*"]), /不明确/);
  await writeFile(path.join(dir, "opencode.json"), JSON.stringify({ permission: "deny" }));
  await allowOpenCodeExternalDirectories(dir, ["/opt/demo/assets/*"]);
  const shorthand = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(shorthand.permission["*"], "deny");
});

test("parseOpenCodeProviders merges V1 provider and V2 providers without leaking keys", () => {
  const entries = parseOpenCodeProviders({
    provider: {
      acme: {
        npm: "@ai-sdk/openai-compatible",
        name: "Acme",
        options: { baseURL: "https://acme.example.com/v1", apiKey: "secret" },
        models: { "coder": { name: "Coder" } },
      },
    },
    providers: {
      acme: { settings: { baseURL: "https://v2.example.com/v1" } },
      beta: {
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: "https://beta.example.com/v1", apiKey: "{env:BETA_KEY}" },
        models: { m1: {} },
      },
    },
  });
  assert.deepEqual(entries.map((entry) => entry.id), ["acme", "beta"]);
  const acme = entries[0];
  assert.equal(acme.baseURL, "https://v2.example.com/v1");
  assert.equal(acme.hasApiKey, true);
  assert.equal((acme as any).apiKey, undefined);
  assert.deepEqual(acme.models, [{ id: "coder", name: "Coder" }]);
  assert.equal(entries[1].apiKeyHint, "{env:BETA_KEY}");
});

test("parseOpenCodeProviders reads model variants", () => {
  const entries = parseOpenCodeProviders({
    provider: {
      acme: {
        options: { baseURL: "https://acme.example.com/v1" },
        models: {
          coder: { name: "Coder", variants: { low: {}, high: { opt: 1 } } },
          chat: {},
        },
      },
    },
  });
  assert.deepEqual(entries[0].models, [
    { id: "chat" },
    { id: "coder", name: "Coder", variants: ["high", "low"] },
  ]);
});

test("parseOpenCodeProviders orders variants from strongest to weakest", () => {
  const entries = parseOpenCodeProviders({
    provider: {
      acme: {
        options: { baseURL: "https://acme.example.com/v1" },
        models: {
          coder: {
            variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
          },
        },
      },
    },
  });
  assert.deepEqual(entries[0].models[0].variants, [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
  ]);
});

test("parseOpenCodeProviders reads image support from modalities", () => {
  const entries = parseOpenCodeProviders({
    provider: {
      acme: {
        options: { baseURL: "https://acme.example.com/v1" },
        models: {
          vision: { modalities: { input: ["text", "image"], output: ["text"] } },
          chat: { modalities: { input: ["text"] } },
          plain: {},
        },
      },
    },
  });
  assert.deepEqual(entries[0].models, [
    { id: "chat", supportsImages: false },
    { id: "plain" },
    { id: "vision", supportsImages: true },
  ]);
});

test("upsert OpenCode provider writes image modality without touching others", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-modalities-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      provider: {
        acme: {
          options: { baseURL: "https://acme.example.com/v1" },
          models: { coder: { modalities: { input: ["text"], output: ["text"] } } },
        },
      },
    }),
  );
  // true=补上 image，output 保留。
  await upsertOpenCodeProvider("project", dir, {
    id: "acme",
    baseURL: "https://acme.example.com/v1",
    models: [{ id: "coder", supportsImages: true }],
  });
  let written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(written.provider.acme.models.coder.modalities, {
    input: ["text", "image"],
    output: ["text"],
  });
  // undefined=保持原样。
  await upsertOpenCodeProvider("project", dir, {
    id: "acme",
    baseURL: "https://acme.example.com/v1",
    models: ["coder"],
  });
  written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(written.provider.acme.models.coder.modalities.input, ["text", "image"]);
  // false=拿掉 image。
  await upsertOpenCodeProvider("project", dir, {
    id: "acme",
    baseURL: "https://acme.example.com/v1",
    models: [{ id: "coder", supportsImages: false }],
  });
  written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(written.provider.acme.models.coder.modalities.input, ["text"]);
});

test("parseOpenCodeProviders reads per-model sdk override", () => {
  const entries = parseOpenCodeProviders({
    provider: {
      yapi: {
        npm: "@ai-sdk/anthropic",
        options: { baseURL: "https://yapi.click/v1" },
        models: {
          "claude-opus-5-5": { name: "Claude Opus 5.5" },
          "grok-4.7": { name: "Grok 4.7", provider: { npm: "@ai-sdk/openai" } },
        },
      },
    },
  });
  assert.equal(entries[0].npm, "@ai-sdk/anthropic");
  assert.deepEqual(entries[0].models, [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "grok-4.7", name: "Grok 4.7", sdk: "@ai-sdk/openai" },
  ]);
});

test("upsert OpenCode provider sets and clears per-model sdk override", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-sdk-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      provider: {
        yapi: {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://yapi.click/v1" },
          models: {
            "grok-4.7": {
              provider: { npm: "@ai-sdk/openai", api: "keep-me" },
            },
          },
        },
      },
    }),
  );
  // 非空=写入覆盖。
  await upsertOpenCodeProvider("project", dir, {
    id: "yapi",
    baseURL: "https://yapi.click/v1",
    models: [{ id: "grok-4.7", sdk: "@ai-sdk/openai" }],
  });
  let written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(written.provider.yapi.models["grok-4.7"].provider.npm, "@ai-sdk/openai");
  // ""=清除 npm 覆盖跟随供应商，同级的 api 等其余键保留。
  await upsertOpenCodeProvider("project", dir, {
    id: "yapi",
    baseURL: "https://yapi.click/v1",
    models: [{ id: "grok-4.7", sdk: "" }],
  });
  written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(written.provider.yapi.models["grok-4.7"].provider?.npm, undefined);
  assert.equal(written.provider.yapi.models["grok-4.7"].provider?.api, "keep-me");
  // 字符串简写=保持原覆盖不动。
  await upsertOpenCodeProvider("project", dir, {
    id: "yapi",
    baseURL: "https://yapi.click/v1",
    models: [{ id: "grok-4.7", sdk: "@ai-sdk/openai" }],
  });
  await upsertOpenCodeProvider("project", dir, {
    id: "yapi",
    baseURL: "https://yapi.click/v1",
    models: ["grok-4.7"],
  });
  written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(written.provider.yapi.models["grok-4.7"].provider.npm, "@ai-sdk/openai");
});

test("OpenCode permission rules round-trip without touching the rest", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-permission-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      model: "acme/coder",
      permission: { bash: "ask", "*": "ask" },
    }),
  );
  let file = await readOpenCodePermissions("project", dir);
  assert.deepEqual(file.rules, { bash: "ask", "*": "ask" });
  // 改一条、加一条。
  await writeOpenCodePermission("project", dir, "bash", "allow");
  await writeOpenCodePermission("project", dir, "edit", "deny");
  file = await readOpenCodePermissions("project", dir);
  assert.deepEqual(file.rules, { bash: "allow", "*": "ask", edit: "deny" });
  // 删一条恢复默认，其余不动。
  await writeOpenCodePermission("project", dir, "bash", null);
  file = await readOpenCodePermissions("project", dir);
  assert.deepEqual(file.rules, { "*": "ask", edit: "deny" });
  const written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(written.model, "acme/coder");
  // 非法工具名和规则拒绝。
  await assert.rejects(writeOpenCodePermission("project", dir, "a b", "allow"));
  await assert.rejects(writeOpenCodePermission("project", dir, "bash", "yes" as any));
});

test("upsert OpenCode provider replaces variants and keeps untouched ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-variants-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      provider: {
        acme: {
          options: { baseURL: "https://acme.example.com/v1" },
          models: { coder: { variants: { low: {}, medium: {} } } },
        },
      },
    }),
  );
  // 字符串简写保持原 variants。
  await upsertOpenCodeProvider("project", dir, {
    id: "acme",
    baseURL: "https://acme.example.com/v1",
    models: ["coder"],
  });
  let written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(Object.keys(written.provider.acme.models.coder.variants).sort(), ["low", "medium"]);
  // 对象写法替换 variants，空数组清空。
  await upsertOpenCodeProvider("project", dir, {
    id: "acme",
    baseURL: "https://acme.example.com/v1",
    models: [
      { id: "coder", variants: ["low", "max", "xhigh", "high", "medium"] },
      { id: "chat", variants: [] },
    ],
  });
  written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.deepEqual(Object.keys(written.provider.acme.models.coder.variants), [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
  ]);
  assert.equal(written.provider.acme.models.chat.variants, undefined);
});

test("upsert/delete OpenCode provider keeps unrelated config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-provider-"));
  await writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({ model: "acme/coder", provider: { other: { options: { baseURL: "https://o.example.com/v1" }, models: { m: {} } } } }),
  );
  const upserted = await upsertOpenCodeProvider("project", dir, {
    id: "acme",
    name: "Acme",
    baseURL: "https://acme.example.com/v1",
    apiKey: "secret",
    models: ["coder", { id: "chat", name: "Chat" }],
  });
  assert.equal(upserted.providers.length, 2);
  const written = JSON.parse(await readFile(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(written.model, "acme/coder");
  assert.equal(written.provider.acme.options.baseURL, "https://acme.example.com/v1");
  assert.equal(written.provider.acme.npm, "@ai-sdk/openai-compatible");
  await assert.rejects(
    () => upsertOpenCodeProvider("project", dir, { id: "bad id!", baseURL: "https://x.example.com", models: ["m"] }),
    /供应商标识/,
  );
  await assert.rejects(
    () => upsertOpenCodeProvider("project", dir, { id: "acme", baseURL: "notaurl", models: ["m"] }),
    /服务地址/,
  );
  const afterDelete = await deleteOpenCodeProvider("project", dir, "acme");
  assert.deepEqual(afterDelete.providers.map((entry) => entry.id), ["other"]);
  await assert.rejects(() => deleteOpenCodeProvider("project", dir, "missing"), /未在/);
});
