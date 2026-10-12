import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openCodeGlobalDir,
  allowOpenCodeExternalDirectories,
  parseJsonc,
  readOpenCodeConfig,
  writeOpenCodeConfig,
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
  await assert.rejects(() => readOpenCodeConfig("project"), /directory/);
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
