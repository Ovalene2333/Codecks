import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  authFromCcSwitchOAuth,
  compactOfficialAuth,
  loadOfficialAuth,
  stripCustomKeys,
} from "./official-auth.js";

test("strips CCS custom API keys from native auth.json", () => {
  const stripped = stripCustomKeys(
    { OPENAI_API_KEY: "sk-custom", tokens: { refresh_token: "rt" } },
    new Set(["sk-custom"]),
  );
  assert.equal(stripped.OPENAI_API_KEY, undefined);
  assert.deepEqual(stripped.tokens, { refresh_token: "rt" });
});

test("keeps a real OpenAI API key that does not belong to a CCS relay", () => {
  const stripped = stripCustomKeys(
    { OPENAI_API_KEY: "sk-openai" },
    new Set(["sk-custom"]),
  );
  assert.equal(stripped.OPENAI_API_KEY, "sk-openai");
});

test("converts CCS preserved Official OAuth into Codex ChatGPT auth", () => {
  const auth = authFromCcSwitchOAuth({
    default_account_id: "acc",
    accounts: {
      acc: {
        account_id: "acct_1",
        refresh_token: "refresh-me",
        authenticated_at: "2026-01-01T00:00:00Z",
      },
    },
  });
  assert.equal(auth?.auth_mode, "chatgpt");
  assert.equal((auth?.tokens as any).refresh_token, "refresh-me");
  assert.equal((auth?.tokens as any).account_id, "acct_1");
  assert.equal((auth?.tokens as any).access_token, undefined);
});

test("loadOfficialAuth prefers CCS OAuth and never reuses a relay key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-deck-auth-"));
  const nativeAuth = path.join(dir, "auth.json");
  const db = path.join(dir, "cc-switch.db");
  await writeFile(nativeAuth, JSON.stringify({ OPENAI_API_KEY: "sk-niko" }));
  await writeFile(
    path.join(dir, "codex_oauth_auth.json"),
    JSON.stringify({
      default_account_id: "acc",
      accounts: { acc: { refresh_token: "official-rt" } },
    }),
  );
  const auth = await loadOfficialAuth({
    nativeAuthPath: nativeAuth,
    ccSwitchDb: db,
    customApiKeys: ["sk-niko"],
    refreshTokens: async (value) => value,
  });
  assert.equal(auth.OPENAI_API_KEY, undefined);
  assert.equal((auth.tokens as any).refresh_token, "official-rt");
});

test("loadOfficialAuth prefers previously refreshed Official tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-deck-auth-"));
  const existing = path.join(dir, "official.json");
  await writeFile(
    existing,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "kept-rt", access_token: "kept-at" },
    }),
  );
  await writeFile(
    path.join(dir, "codex_oauth_auth.json"),
    JSON.stringify({
      default_account_id: "acc",
      accounts: { acc: { refresh_token: "older-ccs-rt" } },
    }),
  );
  const auth = await loadOfficialAuth({
    nativeAuthPath: path.join(dir, "missing.json"),
    existingOfficialAuthPath: existing,
    ccSwitchDb: path.join(dir, "cc-switch.db"),
    refreshTokens: async (value) => value,
  });
  assert.equal((auth.tokens as any).refresh_token, "kept-rt");
});

test("compactOfficialAuth drops empty ChatGPT tokens", () => {
  const compacted = compactOfficialAuth({
    auth_mode: "chatgpt",
    tokens: { refresh_token: "rt", access_token: "", id_token: "" },
  });
  assert.deepEqual(compacted.tokens, { refresh_token: "rt" });
});
