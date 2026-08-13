import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareRuntimeHome } from "./runtime-home.js";

test("runtime home writes isolated Official auth and does not copy native secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-deck-home-"));
  const native = path.join(root, "native");
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(native, "sessions"), { recursive: true });
  await writeFile(
    path.join(native, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-niko" }),
  );
  await writeFile(
    path.join(native, "config.toml"),
    'model_provider = "custom"\n',
  );
  const home = await prepareRuntimeHome(runtime, native, {
    auth_mode: "chatgpt",
    tokens: { refresh_token: "official-rt" },
  });
  const written = JSON.parse(
    await readFile(path.join(home, "auth.json"), "utf8"),
  );
  assert.equal(written.OPENAI_API_KEY, undefined);
  assert.equal(written.tokens.refresh_token, "official-rt");
  await assert.rejects(() => readFile(path.join(home, "config.toml"), "utf8"));
});
