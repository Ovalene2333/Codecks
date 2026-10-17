import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider, PublicProvider, RuntimeModelConfig } from "./types.js";
import { CcSwitchSource, findCcSwitchDb } from "./cc-switch.js";
import { extractProviderApiKey } from "./provider-config.js";

const colors = ["#8b5cf6", "#38bdf8", "#f59e0b", "#22c55e", "#f43f5e"];

export class ProviderStore {
  private providers: Provider[] = [];
  private file: string;
  private runtimeConfigFile: string;
  private modelConfig: RuntimeModelConfig = {};
  private cc?: CcSwitchSource;
  private ccSignature = "";
  private revisionValue = 0;

  constructor(
    private dataDir: string,
    private inheritedCodexHome?: string,
  ) {
    this.file = path.join(dataDir, "providers.json");
    this.runtimeConfigFile = path.join(dataDir, "runtime-config.json");
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.modelConfig = normalizeRuntimeModelConfig(
        JSON.parse(await readFile(this.runtimeConfigFile, "utf8")),
      );
    } catch (error: any) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
      this.modelConfig = {};
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("供应商文件形状错误");
      // Never revive old read-only snapshots when the external source is absent.
      this.providers = parsed.filter((provider) => provider.kind !== "cc-switch");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.providers = [
          {
            id: "local",
            name: "本机 Codex",
            kind: "local-profile",
            color: colors[0],
            codexHome: this.inheritedCodexHome,
            enabled: true,
          },
        ];
        await this.save();
      } else {
        // 脏文件（写一半、手工改坏）：内存用默认 local 保证可启动，
        // 但绝不回写覆盖源文件，否则永久丢失全部自定义供应商与 API Key。
        // 文件保留待手工修复；下次正常 upsert/remove 会用好数据自愈。
        console.error(
          `providers.json 损坏，已用默认配置启动（原文件保留 ${this.file}）:`,
          error?.message || error,
        );
        this.providers = [
          {
            id: "local",
            name: "本机 Codex",
            kind: "local-profile",
            color: colors[0],
            codexHome: this.inheritedCodexHome,
            enabled: true,
          },
        ];
      }
    }
    const db = await findCcSwitchDb(process.env.CC_SWITCH_DB);
    if (db) {
      this.cc = new CcSwitchSource(db);
      await this.syncCcSwitch(true);
    }
    await this.addExistingCodexHomes();
  }

  private async addExistingCodexHomes() {
    const homes = new Map<string, { id: string; name: string }>();
    const nativeHome =
      this.inheritedCodexHome || path.join(os.homedir(), ".codex");
    homes.set(nativeHome, {
      id: "local",
      name: process.env.WSL_DISTRO_NAME
        ? `WSL · ${process.env.WSL_DISTRO_NAME}`
        : "本机 Codex",
    });
    // A runtime owns exactly one native Codex home. Never open a Windows home
    // from WSL (or vice versa): SQLite WAL/SHM files are not cross-OS safe.
    const retained = this.providers.filter((p) => p.kind !== "local-profile");
    const localProviders: Provider[] = [];
    for (const [codexHome, meta] of homes) {
        localProviders.push({
          id: meta.id,
          name: meta.name,
          kind: "local-profile",
          color: colors[localProviders.length % colors.length],
          codexHome,
          enabled: true,
        });
    }
    this.providers = [...localProviders, ...retained];
  }

  async syncCcSwitch(force = false) {
    if (!this.cc) return false;
    const synced = this.cc.readProviders();
    const signature = JSON.stringify(synced);
    if (!force && signature === this.ccSignature) return false;
    this.ccSignature = signature;
    this.providers = [
      ...this.providers.filter((p) => p.kind !== "cc-switch"),
      ...synced,
    ];
    this.revisionValue += 1;
    return true;
  }

  /** Re-discover the CC Switch DB and replace the in-memory CCS provider list. */
  async refreshCcSwitch() {
    const db = await findCcSwitchDb(process.env.CC_SWITCH_DB);
    if (!db) {
      const removed = this.detachCcSwitch();
      return { connected: false, changed: removed };
    }
    const pathChanged = this.cc?.dbPath !== db;
    this.cc = new CcSwitchSource(db);
    const changed = await this.syncCcSwitch(pathChanged);
    return { connected: true, changed, path: db };
  }

  private detachCcSwitch() {
    const hadSource = Boolean(this.cc);
    const hadProviders = this.providers.some((p) => p.kind === "cc-switch");
    this.cc = undefined;
    this.ccSignature = "";
    if (hadProviders) {
      this.providers = this.providers.filter((p) => p.kind !== "cc-switch");
      this.revisionValue += 1;
    }
    return hadSource || hadProviders;
  }

  get ccSwitchPath() {
    return this.cc?.dbPath;
  }

  claudeProfiles() {
    return this.cc?.readClaudeProfiles() || [];
  }

  get revision() {
    return this.revisionValue;
  }

  /**
   * 该 local-profile 行是否就是 Runtime 实际占用的本机 home。Runtime 只能持有
   * 一个 home：其它 local-profile 行（手工添加的、残留的）即使被选中，会话用的
   * 仍是 Runtime home 的 auth.json——对它们不可见、也不装入，避免张冠李戴。
   */
  private isRuntimeProfile(provider: Provider) {
    return (
      provider.kind === "local-profile" &&
      provider.id === this.runtimeProfile().id
    );
  }

  listPublic(): PublicProvider[] {
    return this.providers
      .filter(
        (provider) =>
          provider.kind !== "local-profile" ||
          this.isRuntimeProfile(provider),
      )
      .map(({ apiKey, configToml, authJson, ...item }) => ({
        ...item,
        hasApiKey: Boolean(
          extractProviderApiKey({ apiKey, authJson } as Provider),
        ),
      }));
  }

  get(id: string) {
    return this.providers.find((p) => p.id === id);
  }

  /** The real Codex home used by this Deck process. */
  runtimeProfile() {
    return (
      this.providers.find(
        (p) => p.id === "local" && p.kind === "local-profile",
      ) ||
      this.providers.find((p) => p.kind === "local-profile") || {
        id: "local",
        name: "本机 Codex",
        kind: "local-profile" as const,
        color: colors[0],
        codexHome: this.inheritedCodexHome,
        enabled: true,
      }
    );
  }

  /** Secrets stay server-side; callers use this only to build the app-server process. */
  runtimeProviders() {
    // 本机配置档也作为 Official（requires_openai_auth）装入：没有 CC Switch /
    // 自定义供应商时它往往是唯一连接，缺失会导致会话无法创建。
    return this.providers.filter(
      (p) => p.enabled && (p.kind !== "local-profile" || this.isRuntimeProfile(p)),
    );
  }

  runtimeModelConfig(): RuntimeModelConfig {
    return { ...this.modelConfig };
  }

  async updateRuntimeModelConfig(config: RuntimeModelConfig) {
    const merged = {
      ...this.readRuntimeConfigExtra(),
      ...normalizeRuntimeModelConfig(config),
    };
    await writeJsonAtomic(this.runtimeConfigFile, `${JSON.stringify(merged, null, 2)}\n`);
    this.modelConfig = normalizeRuntimeModelConfig(merged);
    return this.runtimeModelConfig();
  }

  /** 已保存的后端选择（`codexBin` 为空表示跟随 PATH/CODEX_BIN，见 codex-bins）。 */
  runtimeCodexBin(): string {
    return this.readRuntimeConfigExtra().codexBin || "";
  }

  async updateRuntimeCodexBin(bin: string) {
    const extra = this.readRuntimeConfigExtra();
    const next = { ...extra, codexBin: (bin || "").trim() };
    await writeJsonAtomic(this.runtimeConfigFile, `${JSON.stringify(next, null, 2)}\n`);
    this.modelConfig = normalizeRuntimeModelConfig(next);
    return this.runtimeCodexBin();
  }

  /** Claude/OpenCode 的本机 CLI 选择与 Codex 一起保存在 runtime-config.json。 */
  runtimeAgentBin(agent: "claude" | "opencode" | "opencode-v2"): string {
    const key =
      agent === "claude" ? "claudeBin" : agent === "opencode" ? "opencodeBin" : "opencodeV2Bin";
    const config = this.readRuntimeConfigExtra();
    const value = config[key] ?? (agent === "opencode" ? config.opencodeV2Bin : undefined);
    return typeof value === "string" ? value : "";
  }

  async updateRuntimeAgentBin(agent: "claude" | "opencode" | "opencode-v2", bin: string) {
    const key =
      agent === "claude" ? "claudeBin" : agent === "opencode" ? "opencodeBin" : "opencodeV2Bin";
    const next = {
      ...this.readRuntimeConfigExtra(),
      [key]: bin.trim(),
    };
    await writeJsonAtomic(this.runtimeConfigFile, `${JSON.stringify(next, null, 2)}\n`);
    return this.runtimeAgentBin(agent);
  }

  private readRuntimeConfigExtra(): Record<string, any> {
    try {
      const raw = readFileSync(this.runtimeConfigFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { ...(parsed as object) };
    } catch {}
    return {};
  }

  async upsert(
    input: Partial<Provider> & { name: string; kind: Provider["kind"] },
  ) {
    const old = input.id ? this.get(input.id) : undefined;
    const provider: Provider = {
      id: old?.id ?? randomUUID(),
      name: input.name.trim(),
      kind: input.kind,
      color:
        input.color ||
        old?.color ||
        colors[this.providers.length % colors.length],
      model: input.model?.trim() || old?.model,
      baseUrl: input.baseUrl?.trim().replace(/\/$/, "") || old?.baseUrl,
      apiKey: input.apiKey || old?.apiKey,
      wireApi: input.wireApi || old?.wireApi || "responses",
      codexHome: input.codexHome?.trim() || old?.codexHome,
      enabled: input.enabled ?? old?.enabled ?? true,
    };
    if (
      provider.kind === "custom" &&
      (!provider.baseUrl || !provider.model || !provider.apiKey)
    ) {
      throw new Error("自定义供应商需要 Base URL、模型和 API Key");
    }
    const index = this.providers.findIndex((p) => p.id === provider.id);
    if (index >= 0) this.providers[index] = provider;
    else this.providers.push(provider);
    this.revisionValue += 1;
    await this.save();
    return provider;
  }

  async remove(id: string) {
    const provider = this.get(id);
    if (!provider || provider.kind === "local-profile")
      throw new Error("本机供应商不可删除");
    this.providers = this.providers.filter((p) => p.id !== id);
    this.revisionValue += 1;
    await this.save();
  }

  private async save() {
    await writeJsonAtomic(this.file, JSON.stringify(
      this.providers.filter((provider) => provider.kind !== "cc-switch"), null, 2,
    ));
  }
}

/** 原子写 JSON：先落临时文件再 rename，避免崩溃写一半产生脏文件。 */
async function writeJsonAtomic(file: string, content: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

function normalizeRuntimeModelConfig(input: unknown): RuntimeModelConfig {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const positiveInteger = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  return {
    modelContextWindow: positiveInteger(source.modelContextWindow),
    modelAutoCompactTokenLimit: positiveInteger(
      source.modelAutoCompactTokenLimit,
    ),
  };
}
