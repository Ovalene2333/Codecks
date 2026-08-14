import { createHash } from "node:crypto";
import type { Provider } from "./types.js";

export interface RuntimeProviderConfig {
  providerId: string;
  modelProvider: string;
  model?: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** TOML literal strings avoid nested quotes when a .cmd shim is invoked by cmd.exe. */
const toml = (value: string | boolean | number) => {
  if (typeof value !== "string") return JSON.stringify(value);
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
};

function stableSuffix(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export function isOfficialProvider(provider: Provider) {
  return !provider.baseUrl;
}

export function extractProviderApiKey(provider: Provider) {
  if (provider.apiKey?.trim()) return provider.apiKey.trim();
  const auth =
    provider.authJson && typeof provider.authJson === "object"
      ? (provider.authJson as Record<string, unknown>)
      : undefined;
  if (!auth) return "";
  for (const key of ["OPENAI_API_KEY", "api_key", "apiKey", "key"]) {
    const value = auth[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Process-level -c flags. Do not create `model_providers.custom` here: a
 * nameless override makes Codex exit with "provider name must not be empty".
 * Every provider is fully defined here so the native config.toml does not
 * determine which connection a Deck thread uses.
 */
export function runtimeBootstrapArgs(_providers: RuntimeProviderConfig[]) {
  return [] as string[];
}

/**
 * Compile one CCS/custom connection record into process-local Codex config.
 * The returned arguments are passed with `-c`; no user config file is changed.
 */
export function compileRuntimeProvider(
  provider: Provider,
): RuntimeProviderConfig {
  if (isOfficialProvider(provider)) {
    const suffix = stableSuffix(provider.id);
    const modelProvider = `deck_${suffix}`;
    const prefix = `model_providers.${modelProvider}`;
    return {
      providerId: provider.id,
      modelProvider,
      model: provider.model,
      args: [
        "-c",
        `${prefix}.name=${toml(provider.name)}`,
        "-c",
        `${prefix}.wire_api=${toml(provider.wireApi || "responses")}`,
        "-c",
        `${prefix}.requires_openai_auth=true`,
      ],
      env: {},
    };
  }

  if (!provider.baseUrl)
    throw new Error(`供应商 ${provider.name} 缺少 Base URL`);

  const suffix = stableSuffix(provider.id);
  const modelProvider = `deck_${suffix}`;
  const prefix = `model_providers.${modelProvider}`;
  const apiKey = extractProviderApiKey(provider);
  const args = [
    "-c",
    `${prefix}.name=${toml(provider.name)}`,
    "-c",
    `${prefix}.base_url=${toml(provider.baseUrl)}`,
    "-c",
    `${prefix}.wire_api=${toml(provider.wireApi || "responses")}`,
    "-c",
    `${prefix}.requires_openai_auth=false`,
  ];
  const env: NodeJS.ProcessEnv = {};

  if (apiKey) {
    const envKey = `CODEX_DECK_PROVIDER_${suffix.toUpperCase()}`;
    args.push("-c", `${prefix}.env_key=${toml(envKey)}`);
    env[envKey] = apiKey;
  }

  return {
    providerId: provider.id,
    modelProvider,
    model: provider.model,
    args,
    env,
  };
}
