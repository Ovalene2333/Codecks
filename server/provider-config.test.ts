import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRuntimeProvider,
  runtimeBootstrapArgs,
} from "./provider-config.js";

const base = {
  color: "#fff",
  enabled: true,
  kind: "cc-switch" as const,
};

test("maps OpenAI Official to ChatGPT login, not api.openai.com", () => {
  const result = compileRuntimeProvider({
    ...base,
    id: "cc-official",
    name: "OpenAI Official",
    model: "gpt-test",
  });
  assert.match(result.modelProvider, /^deck_[a-f0-9]{12}$/);
  assert.notEqual(result.modelProvider, "openai");
  assert.ok(
    result.args.some((arg) => arg.endsWith("requires_openai_auth=true")),
  );
  assert.ok(!result.args.some((arg) => arg.includes("base_url=")));
  assert.deepEqual(result.env, {});
});

test("compiles a CCS relay into isolated process-local overrides", () => {
  const result = compileRuntimeProvider({
    ...base,
    id: "cc-relay",
    name: "Relay",
    model: "other-model",
    baseUrl: "https://relay.example/v1",
    wireApi: "responses",
    authJson: { OPENAI_API_KEY: "secret" },
  });
  assert.match(result.modelProvider, /^deck_[a-f0-9]{12}$/);
  assert.equal(result.model, "other-model");
  assert.ok(
    result.args.includes(
      "model_providers." +
        result.modelProvider +
        ".base_url='https://relay.example/v1'",
    ),
  );
  const [envKey] = Object.keys(result.env);
  assert.match(envKey, /^CODEX_DECK_PROVIDER_[A-F0-9]{12}$/);
  assert.equal(result.env[envKey], "secret");
  assert.ok(result.args.some((arg) => arg.endsWith(`env_key='${envKey}'`)));
  assert.ok(
    result.args.some((arg) => arg.endsWith("requires_openai_auth=false")),
  );
});

test("does not fall back to Official ChatGPT login for a custom API", () => {
  const result = compileRuntimeProvider({
    ...base,
    id: "cc-login",
    name: "Login relay",
    baseUrl: "https://relay.example/v1",
    wireApi: "chat",
  });
  assert.deepEqual(result.env, {});
  assert.ok(
    result.args.some((arg) => arg.endsWith("requires_openai_auth=false")),
  );
  assert.ok(
    !result.args.some((arg) => arg.endsWith("requires_openai_auth=true")),
  );
  assert.ok(result.args.some((arg) => arg.endsWith("wire_api='chat'")));
});

test("compiles connection overlay onto the isolated provider", () => {
  const official = compileRuntimeProvider(
    { ...base, id: "cc-official", name: "OpenAI Official" },
    { requestMaxRetries: 8, streamMaxRetries: 10, streamIdleTimeoutMs: 120000 },
  );
  assert.ok(
    official.args.includes(
      "model_providers." + official.modelProvider + ".request_max_retries=8",
    ),
  );
  assert.ok(
    official.args.includes(
      "model_providers." + official.modelProvider + ".stream_max_retries=10",
    ),
  );
  assert.ok(
    official.args.includes(
      "model_providers." +
        official.modelProvider +
        ".stream_idle_timeout_ms=120000",
    ),
  );

  const relay = compileRuntimeProvider(
    {
      ...base,
      id: "cc-relay",
      name: "Relay",
      baseUrl: "https://relay.example/v1",
    },
    { requestMaxRetries: 2 },
  );
  assert.ok(
    relay.args.includes(
      "model_providers." + relay.modelProvider + ".request_max_retries=2",
    ),
  );
  assert.ok(!relay.args.some((arg) => arg.includes("stream_max_retries")));
});

test("runtime bootstrap does not default Official onto a CCS relay", () => {
  const official = compileRuntimeProvider({
    ...base,
    id: "cc-official",
    name: "OpenAI Official",
  });
  const relay = compileRuntimeProvider({
    ...base,
    id: "cc-relay",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
    authJson: { OPENAI_API_KEY: "secret" },
  });
  const args = runtimeBootstrapArgs([official, relay]);
  assert.deepEqual(args, []);
});
