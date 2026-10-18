import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sortReasoningVariants } from "../shared/reasoning-variants.js";

export type OpenCodeConfigScope = "global" | "project";

export interface OpenCodeAgentPatch {
  model?: string | null;
  disable?: boolean | null;
  prompt?: string | null;
  temperature?: number | null;
}

export interface OpenCodeConfigUpdate {
  agent?: Record<string, OpenCodeAgentPatch>;
  model?: string | null;
  smallModel?: string | null;
}

export interface OpenCodeConfigFile {
  scope: OpenCodeConfigScope;
  /** 目标文件路径；不存在时是将要创建的 `opencode.json` 路径。 */
  path: string;
  exists: boolean;
  config: Record<string, any>;
}

const CONFIG_BASENAMES = ["opencode.json", "opencode.jsonc"];

/**
 * Deck 读写的全局配置目录，与 `opencode serve` 看到的一致：
 * `OPENCODE_CONFIG_DIR`（opencode 原生支持的额外全局配置目录）优先，
 * 其次 `XDG_CONFIG_HOME/opencode`，最后 `~/.config/opencode`。
 * serve 子进程直接继承 Deck 的环境，同一组变量对两边同时生效；
 * 沙箱/托管环境想让 serve 用另一份配置时显式设置这些变量即可，
 * Deck 不会根据 /etc/passwd 猜测别的 home。
 */
export function openCodeGlobalDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
) {
  if (env.OPENCODE_CONFIG_DIR)
    return path.resolve(env.OPENCODE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME || path.join(homedir, ".config");
  return path.join(xdg, "opencode");
}

/**
 * 容忍 `.jsonc` 的解析：剥掉字符串之外的 `//` 与 `/* *\/` 注释，
 * 再去掉对象/数组尾逗号。`https://` 之类的 URL 在字符串内不受影响。
 */
export function parseJsonc(text: string): Record<string, any> {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  // 尾逗号：`,` 之后（忽略空白）紧跟 `}` 或 `]` 时删去逗号。上一步已
  // 清掉注释，字符串原样保留，这里只需跳过字符串本身。
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned);
}

function configDir(scope: OpenCodeConfigScope, directory?: string) {
  if (scope === "global") return openCodeGlobalDir();
  if (!directory) throw new Error("项目范围必须提供目录");
  return path.resolve(directory);
}

/**
 * 读取 opencode 配置。项目级优先 `opencode.json`，其次 `opencode.jsonc`；
 * 都没有时返回指向 `opencode.json` 的空配置，供写入时创建。
 * 全局与项目共用同一 schema，区别只在目录。
 */
export async function readOpenCodeConfig(
  scope: OpenCodeConfigScope,
  directory?: string,
): Promise<OpenCodeConfigFile> {
  const dir = configDir(scope, directory);
  for (const basename of CONFIG_BASENAMES) {
    const file = path.join(dir, basename);
    try {
      const text = await readFile(file, "utf8");
      const config = parseJsonc(text);
      return {
        scope,
        path: file,
        exists: true,
        config:
          config && typeof config === "object" && !Array.isArray(config)
            ? config
            : {},
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      if (error instanceof SyntaxError)
        throw new Error(`${file} 解析失败：${error.message}`);
      throw error;
    }
  }
  return {
    scope,
    path: path.join(dir, "opencode.json"),
    exists: false,
    config: {},
  };
}

/**
 * 把 agent 补丁合并进配置文件。`null` 表示删除该键（恢复上游/默认），
 * `disable: false` 同样落成删除，保持文件干净。
 */
export async function writeOpenCodeConfig(
  scope: OpenCodeConfigScope,
  directory: string | undefined,
  update: OpenCodeConfigUpdate,
): Promise<OpenCodeConfigFile> {
  const file = await readOpenCodeConfig(scope, directory);
  const config = file.config;
  if (update.model !== undefined) {
    if (update.model === null) delete config.model;
    else config.model = update.model;
  }
  if (update.smallModel !== undefined) {
    if (update.smallModel === null) delete config.small_model;
    else config.small_model = update.smallModel;
  }
  if (update.agent) {
    const agents =
      config.agent && typeof config.agent === "object" ? config.agent : {};
    config.agent = agents;
    for (const [name, patch] of Object.entries(update.agent)) {
      const entry =
        agents[name] && typeof agents[name] === "object" ? agents[name] : {};
      agents[name] = entry;
      for (const key of ["model", "prompt", "temperature"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete entry[key];
        else entry[key] = value;
      }
      if (patch.disable !== undefined) {
        if (patch.disable) entry.disable = true;
        else delete entry.disable;
      }
      if (!Object.keys(entry).length) delete agents[name];
    }
    if (!Object.keys(agents).length) delete config.agent;
  }
  if (config.$schema === undefined && !file.exists)
    config.$schema = "https://opencode.ai/config.json";
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file.path);
  return { ...file, exists: true, config };
}

export interface OpenCodeProviderModel {
  id: string;
  name?: string;
  /** 模型 variants（如 low/medium/high）：opencode.json 里是 `models.<id>.variants` 的 key 集合。 */
  variants?: string[];
  /** 按模型覆盖的 SDK 包（`models.<id>.provider.npm`），缺省=跟随供应商。 */
  sdk?: string;
  /**
   * 是否支持图片输入：取自 `models.<id>.modalities.input` 是否含 image。
   * 中转声明的未知模型默认只有 text，不声明就没有视觉能力；缺省表示未知。
   */
  supportsImages?: boolean;
}

/** `modalities.input` 里是否含 image（大小写不敏感）。缺省表示未知。 */
function supportsImagesOf(value: unknown): boolean | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = (value as { input?: unknown }).input;
    if (Array.isArray(input))
      return input.some((item) => String(item).toLowerCase() === "image");
  }
  return undefined;
}

export interface OpenCodeProviderEntry {
  id: string;
  name: string;
  /** V1 `npm` / V2 `package`，缺省为 OpenAI 兼容包。 */
  npm?: string;
  baseURL?: string;
  hasApiKey: boolean;
  /** 模板引用（`{env:KEY}` / `{file:...}`）可安全回显；明文 key 只返回掩码状态。 */
  apiKeyHint?: string;
  /**
   * OpenCode 运行时是否可用该供应商（凭据来自 auth.json、环境变量或配置）。
   * 由 serve 的 `/provider` 探测附加；离线或未探测时缺省，不据此判断无 Key。
   */
  connected?: boolean;
  models: OpenCodeProviderModel[];
}

export interface OpenCodeProviderFile {
  scope: OpenCodeConfigScope;
  path: string;
  /** 展示用路径：家目录前缀收成 `~`，前端直接展示，hover 看全路径。 */
  displayPath: string;
  exists: boolean;
  providers: OpenCodeProviderEntry[];
}

/** 家目录前缀收成 `~`，长绝对路径在设置页里不再那么刺眼。 */
export function displayPathFor(
  filePath: string,
  homedir: string = os.homedir(),
): string {
  const prefix = homedir.endsWith(path.sep) ? homedir : homedir + path.sep;
  return filePath.startsWith(prefix)
    ? `~${path.sep}${filePath.slice(prefix.length)}`
    : filePath;
}

const OPENCODE_PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_PROVIDER_NPM = "@ai-sdk/openai-compatible";

function isSecretTemplate(value: unknown) {
  return (
    typeof value === "string" &&
    (value.startsWith("{env:") || value.startsWith("{file:"))
  );
}

function providerRecord(
  config: Record<string, any>,
  key: "provider" | "providers",
): Record<string, any> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function normalizeOneProvider(id: string, raw: any): OpenCodeProviderEntry {
  const entry = raw && typeof raw === "object" ? raw : {};
  const options = entry.options && typeof entry.options === "object" ? entry.options : {};
  const settings = entry.settings && typeof entry.settings === "object" ? entry.settings : {};
  const baseURL =
    typeof settings.baseURL === "string"
      ? settings.baseURL
      : typeof options.baseURL === "string"
        ? options.baseURL
        : typeof entry.api === "string"
          ? entry.api
          : undefined;
  const apiKey = settings.apiKey ?? options.apiKey;
  const modelsRaw =
    entry.models && typeof entry.models === "object" && !Array.isArray(entry.models)
      ? (entry.models as Record<string, any>)
      : {};
  const models: OpenCodeProviderModel[] = Object.entries(modelsRaw)
    .map(([modelId, meta]) => {
      const metaObj = meta && typeof meta === "object" ? (meta as any) : {};
      const variantsRaw = metaObj.variants;
      const variants =
        variantsRaw && typeof variantsRaw === "object" && !Array.isArray(variantsRaw)
          ? sortReasoningVariants(
              Object.keys(variantsRaw as Record<string, unknown>)
                .map((name) => String(name).trim())
                .filter(Boolean),
            )
          : [];
      const supportsImages = supportsImagesOf(metaObj.modalities);
      const modelProvider =
        metaObj.provider && typeof metaObj.provider === "object" && !Array.isArray(metaObj.provider)
          ? (metaObj.provider as Record<string, unknown>)
          : undefined;
      const sdk =
        modelProvider && typeof modelProvider.npm === "string" && modelProvider.npm.trim()
          ? modelProvider.npm.trim()
          : undefined;
      return {
        id: String(modelId),
        ...(typeof metaObj.name === "string" && metaObj.name.trim()
          ? { name: String(metaObj.name).trim() }
          : {}),
        ...(variants.length ? { variants } : {}),
        ...(supportsImages !== undefined ? { supportsImages } : {}),
        // 按模型覆盖 SDK（如 grok 走 openai，其余走 anthropic）；缺省=跟随供应商。
        ...(sdk ? { sdk } : {}),
      };
    })
    .filter((model) => model.id.trim())
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
    ...((typeof entry.package === "string" && entry.package.trim()) ||
    (typeof entry.npm === "string" && entry.npm.trim())
      ? { npm: String(entry.package || entry.npm).trim() }
      : {}),
    ...(baseURL?.trim() ? { baseURL: baseURL.trim() } : {}),
    hasApiKey:
      (typeof apiKey === "string" && apiKey.trim().length > 0) ||
      (apiKey != null && typeof apiKey !== "string"),
    ...(isSecretTemplate(typeof apiKey === "string" ? apiKey.trim() : apiKey)
      ? { apiKeyHint: String(apiKey).trim() }
      : {}),
    models,
  };
}

/**
 * 解析 opencode.json(c) 的自定义 provider。V1 用单数 `provider`，
 * V2 用复数 `providers`（`package`/`settings` 形态）；两者同时存在时按 id
 * 合并，V2 形态优先。内置供应商不在文件里，这里只返回文件声明的条目。
 */
export function parseOpenCodeProviders(
  config: Record<string, any>,
): OpenCodeProviderEntry[] {
  const merged = new Map<string, any>();
  for (const [id, entry] of Object.entries(providerRecord(config, "provider")))
    merged.set(id, entry);
  for (const [id, entry] of Object.entries(providerRecord(config, "providers")))
    merged.set(id, { ...(merged.get(id) || {}), ...(entry || {}), __v2: true });
  return [...merged.entries()]
    .map(([id, entry]) => normalizeOneProvider(id, entry))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 读取某作用域文件的 provider 列表（脱敏：明文 key 只返回 hasApiKey）。 */
export async function listOpenCodeProviders(
  scope: OpenCodeConfigScope,
  directory?: string,
): Promise<OpenCodeProviderFile> {
  const file = await readOpenCodeConfig(scope, directory);
  return {
    scope,
    path: file.path,
    displayPath: displayPathFor(file.path),
    exists: file.exists,
    providers: parseOpenCodeProviders(file.config),
  };
}

export interface OpenCodeProviderModelInput {
  id: string;
  name?: string;
  /** undefined=保持原 variants（字符串简写同样保持），空数组=清空。 */
  variants?: string[];
  /** undefined=保持原 modalities，true/false=改写 input 是否含 image。 */
  supportsImages?: boolean;
  /** undefined=保持原覆盖，""=清除覆盖跟随供应商，非空=写入 `provider.npm`。 */
  sdk?: string;
}

/** 把 modalities.input 调整为含/不含 image，其余（output 等）原样保留。 */
function withImageModality(value: unknown, supportsImages: boolean): Record<string, unknown> {
  const current =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const input = Array.isArray(current.input)
    ? current.input.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const has = (name: string) => input.some((item) => item.toLowerCase() === name);
  if (supportsImages) {
    if (!has("text")) input.unshift("text");
    if (!has("image")) input.push("image");
  } else {
    for (let i = input.length - 1; i >= 0; i -= 1)
      if (input[i].toLowerCase() === "image") input.splice(i, 1);
    if (!input.length) input.push("text");
  }
  return {
    ...current,
    input,
    ...(!Array.isArray(current.output) ? { output: ["text"] } : {}),
  };
}

export interface OpenCodeProviderInput {
  id: string;
  name?: string;
  npm?: string;
  baseURL: string;
  /** undefined=保持不变，""=删除，明文或 `{env:KEY}`/`{file:...}` 模板=写入。 */
  apiKey?: string;
  models: (string | OpenCodeProviderModelInput)[];
}

function normalizeVariantNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    const name = String((item as any)?.name ?? item ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
  }
  return sortReasoningVariants([...seen]);
}

function normalizeModelInputs(
  models: OpenCodeProviderInput["models"],
): {
  id: string;
  name?: string;
  variants?: string[];
  supportsImages?: boolean;
  sdk?: string;
}[] {
  const seen = new Map<
    string,
    {
      id: string;
      name?: string;
      variants?: string[];
      supportsImages?: boolean;
      sdk?: string;
    }
  >();
  for (const item of models || []) {
    const id = (typeof item === "string" ? item : item?.id || "").trim();
    if (!id) continue;
    const name =
      typeof item === "object" && typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : undefined;
    const variants =
      typeof item === "object" ? normalizeVariantNames(item.variants) : undefined;
    const supportsImages =
      typeof item === "object" && typeof item.supportsImages === "boolean"
        ? item.supportsImages
        : undefined;
    const sdk =
      typeof item === "object" && typeof item.sdk === "string"
        ? item.sdk.trim()
        : undefined;
    if (!seen.has(id)) {
      const entry: {
        id: string;
        name?: string;
        variants?: string[];
        supportsImages?: boolean;
        sdk?: string;
      } = { id };
      if (name) entry.name = name;
      if (variants !== undefined) entry.variants = variants;
      if (supportsImages !== undefined) entry.supportsImages = supportsImages;
      if (sdk !== undefined) entry.sdk = sdk;
      seen.set(id, entry);
    } else {
      const entry = seen.get(id)!;
      if (name) entry.name = name;
      if (variants !== undefined) entry.variants = variants;
      if (supportsImages !== undefined) entry.supportsImages = supportsImages;
      if (sdk !== undefined) entry.sdk = sdk;
    }
  }
  return [...seen.values()];
}

/**
 * 新增或更新一个自定义 provider，写回与文件现有格式一致的形态：
 * 已用 V2 `providers` 的文件继续写 `package`/`settings`，否则写 V1
 * `npm`/`options`（V1 仍被 V2 归一化接受）。其余配置原样保留。
 */
export async function upsertOpenCodeProvider(
  scope: OpenCodeConfigScope,
  directory: string | undefined,
  input: OpenCodeProviderInput,
): Promise<OpenCodeProviderFile> {
  const id = String(input.id || "").trim();
  if (!OPENCODE_PROVIDER_ID_RE.test(id) || id.length > 64)
    throw new Error("供应商标识只能包含字母、数字、._-，且以字母数字开头");
  const baseURL = String(input.baseURL || "").trim();
  if (!/^https?:\/\/.+/i.test(baseURL)) throw new Error("服务地址须是 http(s) 地址");
  const models = normalizeModelInputs(input.models);
  if (!models.length) throw new Error("至少声明一个模型");
  const npm = String(input.npm || "").trim() || DEFAULT_PROVIDER_NPM;

  const file = await readOpenCodeConfig(scope, directory);
  const config = file.config;
  const useV2 =
    config.providers && typeof config.providers === "object" && !Array.isArray(config.providers) &&
    !(config.provider && typeof config.provider === "object");
  const key = useV2 ? "providers" : "provider";
  const record = providerRecord(config, key);
  const existing = record[id] && typeof record[id] === "object" ? record[id] : {};
  const existingModels =
    existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
      ? (existing.models as Record<string, any>)
      : {};
  const nextModels: Record<string, any> = {};
  for (const model of models) {
    const kept = existingModels[model.id] && typeof existingModels[model.id] === "object"
      ? { ...existingModels[model.id] }
      : {};
    if (model.name) kept.name = model.name;
    // supportsImages：未提供=保持原 modalities；提供=改写 input 是否含 image。
    if (model.supportsImages !== undefined)
      kept.modalities = withImageModality(kept.modalities, model.supportsImages);
    // sdk：未提供（字符串简写）=保持原覆盖；""=清除覆盖跟随供应商；非空=写入覆盖。
    if (model.sdk !== undefined) {
      if (model.sdk) {
        const keptProvider =
          kept.provider && typeof kept.provider === "object" && !Array.isArray(kept.provider)
            ? { ...(kept.provider as Record<string, unknown>) }
            : {};
        keptProvider.npm = model.sdk;
        kept.provider = keptProvider;
      } else if (kept.provider && typeof kept.provider === "object" && !Array.isArray(kept.provider)) {
        const { npm: _dropped, ...rest } = kept.provider as Record<string, unknown>;
        if (Object.keys(rest).length) kept.provider = rest;
        else delete kept.provider;
      }
    }
    // variants：未提供=保持原样（兼容旧的字符串简写）；提供数组=替换，空数组=清空。
    if (model.variants !== undefined) {
      if (!model.variants.length) {
        delete kept.variants;
      } else {
        const existingVariants =
          kept.variants && typeof kept.variants === "object" && !Array.isArray(kept.variants)
            ? (kept.variants as Record<string, unknown>)
            : {};
        const nextVariants: Record<string, unknown> = {};
        for (const name of model.variants) {
          const prev = existingVariants[name];
          nextVariants[name] =
            prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
        }
        kept.variants = nextVariants;
      }
    }
    nextModels[model.id] = kept;
  }
  if (useV2) {
    const settings =
      existing.settings && typeof existing.settings === "object" ? { ...existing.settings } : {};
    settings.baseURL = baseURL;
    if (input.apiKey !== undefined) {
      if (!input.apiKey.trim()) delete settings.apiKey;
      else settings.apiKey = input.apiKey.trim();
    }
    record[id] = {
      ...existing,
      name: String(input.name || "").trim() || (typeof existing.name === "string" ? existing.name : id),
      package: npm,
      settings,
      models: nextModels,
    };
    delete record[id].npm;
    delete record[id].options;
  } else {
    const options =
      existing.options && typeof existing.options === "object" ? { ...existing.options } : {};
    options.baseURL = baseURL;
    if (input.apiKey !== undefined) {
      if (!input.apiKey.trim()) delete options.apiKey;
      else options.apiKey = input.apiKey.trim();
    }
    record[id] = {
      ...existing,
      npm,
      name: String(input.name || "").trim() || (typeof existing.name === "string" ? existing.name : id),
      options,
      models: nextModels,
    };
    delete record[id].package;
    delete record[id].settings;
  }
  config[key] = record;
  if (config.$schema === undefined && !file.exists)
    config.$schema = "https://opencode.ai/config.json";
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file.path);
  return {
    scope,
    path: file.path,
    displayPath: displayPathFor(file.path),
    exists: true,
    providers: parseOpenCodeProviders(config),
  };
}

/** 从某作用域文件删除一个自定义 provider；其余配置原样保留。 */
export async function deleteOpenCodeProvider(
  scope: OpenCodeConfigScope,
  directory: string | undefined,
  id: string,
): Promise<OpenCodeProviderFile> {
  const key = String(id || "").trim();
  if (!key) throw new Error("供应商标识不能为空");
  const file = await readOpenCodeConfig(scope, directory);
  const config = file.config;
  let removed = false;
  for (const mapKey of ["provider", "providers"] as const) {
    const record = providerRecord(config, mapKey);
    if (record[key] !== undefined) {
      delete record[key];
      removed = true;
    }
    if (!Object.keys(record).length) delete config[mapKey];
    else config[mapKey] = record;
  }
  if (!removed) throw new Error(`未在配置文件中找到供应商 ${key}`);
  if (!file.exists) throw new Error(`未在配置文件中找到供应商 ${key}`);
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file.path);
  return {
    scope,
    path: file.path,
    displayPath: displayPathFor(file.path),
    exists: true,
    providers: parseOpenCodeProviders(config),
  };
}

export type OpenCodePermissionRule = "ask" | "allow" | "deny";

export interface OpenCodePermissionsFile {
  scope: OpenCodeConfigScope;
  path: string;
  exists: boolean;
  /** permission 段里的纯文本工具规则；external_directory 等对象规则不在这里。 */
  rules: Record<string, OpenCodePermissionRule>;
}

const OPENCODE_PERMISSION_RULES: ReadonlySet<string> = new Set(["ask", "allow", "deny"]);

function permissionMap(config: Record<string, any>): Record<string, any> {
  const value = config.permission;
  // 字符串简写视作对所有工具的同一规则，读成 {"*": rule}。
  if (typeof value === "string") return { "*": value };
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

/** 读取某作用域文件的工具权限表（只取 ask/allow/deny 纯文本规则）。 */
export async function readOpenCodePermissions(
  scope: OpenCodeConfigScope,
  directory?: string,
): Promise<OpenCodePermissionsFile> {
  const file = await readOpenCodeConfig(scope, directory);
  const rules: Record<string, OpenCodePermissionRule> = {};
  for (const [tool, rule] of Object.entries(permissionMap(file.config))) {
    if (typeof rule === "string" && OPENCODE_PERMISSION_RULES.has(rule.trim()))
      rules[tool] = rule.trim() as OpenCodePermissionRule;
  }
  return { scope, path: file.path, exists: file.exists, rules };
}

/**
 * 写一条工具权限：`rule` 为 null/undefined=删除该键（恢复默认），
 * `tool` 为 `*` 表示所有工具；其余配置原样保留。改动要重载 OpenCode 生效。
 */
export async function writeOpenCodePermission(
  scope: OpenCodeConfigScope,
  directory: string | undefined,
  tool: string,
  rule: OpenCodePermissionRule | null | undefined,
): Promise<OpenCodePermissionsFile> {
  const name = String(tool || "").trim();
  if (name !== "*" && !OPENCODE_PROVIDER_ID_RE.test(name))
    throw new Error("工具名只能包含字母、数字、._-，且以字母数字开头（* 表示所有工具）");
  if (
    rule !== null &&
    rule !== undefined &&
    !OPENCODE_PERMISSION_RULES.has(String(rule).trim())
  )
    throw new Error("规则只能是 ask / allow / deny，留空=恢复默认");
  const file = await readOpenCodeConfig(scope, directory);
  const config = file.config;
  const record = permissionMap(config);
  if (rule === null || rule === undefined) delete record[name];
  else record[name] = String(rule).trim();
  if (!Object.keys(record).length) delete config.permission;
  else config.permission = record;
  if (config.$schema === undefined && !file.exists)
    config.$schema = "https://opencode.ai/config.json";
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file.path);
  return readOpenCodePermissions(scope, directory);
}

/** 将项目外目录的精确授权模式写入 OpenCode 原生项目配置，供新会话和 TUI 共用。 */
export async function allowOpenCodeExternalDirectories(
  directory: string,
  patterns: string[],
): Promise<OpenCodeConfigFile> {
  if (!patterns.length || patterns.some((pattern) => {
    if (typeof pattern !== "string") return true;
    const prefix = pattern.split(/[?*]/, 1)[0];
    return !path.isAbsolute(prefix) || path.parse(prefix).root === prefix;
  })) {
    throw new Error("无法持久授权不明确的项目外目录模式");
  }
  const file = await readOpenCodeConfig("project", directory);
  const config = file.config;
  const permissions = config.permission && typeof config.permission === "object" && !Array.isArray(config.permission)
    ? config.permission
    : (config.permission = typeof config.permission === "string"
      ? { "*": config.permission }
      : {});
  const existing = permissions.external_directory;
  const rules: Record<string, string> = typeof existing === "string"
    ? { "*": existing }
    : existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
  for (const pattern of patterns) {
    delete rules[pattern]; // OpenCode 以最后匹配的规则为准。
    rules[pattern] = "allow";
  }
  permissions.external_directory = rules;
  if (config.$schema === undefined && !file.exists)
    config.$schema = "https://opencode.ai/config.json";
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file.path);
  return { ...file, exists: true, config };
}
