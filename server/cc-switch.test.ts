import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CcSwitchSource, findCcSwitchDb } from "./cc-switch.js";

test("reads codex providers from cc switch without exposing unrelated apps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-switch-"));
  const file = path.join(dir, "cc-switch.db");
  const db = new DatabaseSync(file);
  db.exec(
    "create table providers (id text, app_type text, name text, settings_config text, icon_color text, is_current integer, sort_index integer)",
  );
  const insert = db.prepare(
    "insert into providers values (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    "one",
    "codex",
    "Gateway",
    JSON.stringify({
      auth: { OPENAI_API_KEY: "secret" },
      config:
        'model = "gpt-test"\n[model_providers.custom]\nbase_url = "https://example.test/v1"\nwire_api = "responses"',
    }),
    "#123456",
    1,
    0,
  );
  insert.run("two", "claude", "Ignore", "{}", null, 0, 1);
  db.close();
  const providers = new CcSwitchSource(file).readProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, "Gateway");
  assert.equal(providers[0].model, "gpt-test");
  assert.equal(providers[0].baseUrl, "https://example.test/v1");
  assert.equal(providers[0].current, true);
});

test("reads Claude profiles while public callers can omit secret env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-switch-"));
  const file = path.join(dir, "cc-switch.db");
  const db = new DatabaseSync(file);
  db.exec(
    "create table providers (id text, app_type text, name text, settings_config text, icon_color text, is_current integer, sort_index integer)",
  );
  db.prepare("insert into providers values (?, ?, ?, ?, ?, ?, ?)").run(
    "claude-one",
    "claude",
    "Claude Gateway",
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://example.test",
        ANTHROPIC_AUTH_TOKEN: "super-secret",
        IGNORED_NUMBER: 42,
      },
    }),
    "#d97757",
    1,
    0,
  );
  db.close();

  const profiles = new CcSwitchSource(file).readClaudeProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "claude-cc-claude-one");
  assert.equal(profiles[0].current, true);
  assert.equal(profiles[0].env.ANTHROPIC_AUTH_TOKEN, "super-secret");
  assert.equal("IGNORED_NUMBER" in profiles[0].env, false);
});

test("findCcSwitchDb uses an explicit path and does not fall through", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-switch-"));
  const file = path.join(dir, "cc-switch.db");
  await writeFile(file, "");
  assert.equal(await findCcSwitchDb(file), file);
  assert.equal(await findCcSwitchDb(path.join(dir, "missing.db")), undefined);
});
