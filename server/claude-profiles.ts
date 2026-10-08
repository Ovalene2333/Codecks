import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface ClaudeProfile {
  id: string;
  name: string;
  color: string;
  current: boolean;
  official: boolean;
  supported: boolean;
  env: Record<string, string>;
  kind?: "local-profile" | "custom" | "cc-switch";
  model?: string;
}

/** Shared by native Deck profiles and the optional CC Switch importer. */
export function classifyClaudeEnvironment(env: Record<string, string>) {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  let endpointValid = true;
  let officialEndpoint = !baseUrl;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      endpointValid = url.protocol === "https:" || url.protocol === "http:";
      officialEndpoint = url.hostname.toLowerCase() === "api.anthropic.com";
    } catch {
      endpointValid = false;
    }
  }
  const cloudProvider = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((key) => env[key] === "1");
  const hasCredential = [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_CUSTOM_HEADERS",
  ].some((key) => Boolean(env[key]?.trim()));
  return {
    official: officialEndpoint && !hasCredential && !cloudProvider,
    supported: endpointValid && (hasCredential || cloudProvider),
    hasCredential,
  };
}

const recordSchema = z.object({
  id: z.string().startsWith("claude-custom-"),
  name: z.string().trim().min(1),
  color: z.string().optional(),
  model: z.string().trim().optional(),
  env: z.record(z.string(), z.string()),
});
type ProfileRecord = z.infer<typeof recordSchema>;

export const claudeProviderInput = z.object({
  id: z.string().startsWith("claude-custom-").optional(),
  name: z.string().trim().min(1),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "Claude Base URL 必须使用 HTTP 或 HTTPS",
    }),
  apiKey: z.string().trim().optional(),
  authType: z.enum(["api-key", "auth-token"]).default("api-key"),
  model: z.string().trim().optional(),
});

/** Deck-owned credentials. Imported profiles are never persisted here. */
export class ClaudeProviderStore {
  private records: ProfileRecord[] = [];
  private loadError = false;
  private file: string;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "claude-providers.json");
  }

  async load() {
    try {
      this.records = z
        .array(recordSchema)
        .parse(JSON.parse(await readFile(this.file, "utf8")));
      this.loadError = false;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.records = [];
        this.loadError = false;
      } else {
        // Keep both the original file and any last-known-good in-memory copy.
        this.loadError = true;
        console.error(
          "Claude 供应商配置读取失败，原文件保留；本机 Claude 仍可使用",
        );
      }
    }
  }

  profiles(): ClaudeProfile[] {
    return this.records.map((record) => {
      const { official, supported } = classifyClaudeEnvironment(record.env);
      return {
        ...record,
        env: { ...record.env },
        color: record.color || "#d97757",
        kind: "custom",
        current: false,
        official,
        supported,
      };
    });
  }

  upsert(value: z.input<typeof claudeProviderInput>) {
    return this.mutate(async () => {
      const input = claudeProviderInput.parse(value);
      const old = this.records.find((record) => record.id === input.id);
      if (input.id && !old) throw new Error("Claude 自定义供应商不存在");
      const env: Record<string, string> = {
        ...old?.env,
        ANTHROPIC_BASE_URL: input.baseUrl,
      };
      if (input.apiKey) {
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        env[
          input.authType === "auth-token"
            ? "ANTHROPIC_AUTH_TOKEN"
            : "ANTHROPIC_API_KEY"
        ] = input.apiKey;
      }
      if (!classifyClaudeEnvironment(env).supported)
        throw new Error(
          "Claude 自定义供应商需要有效地址和 API Key 或 Auth Token",
        );
      const record: ProfileRecord = {
        id: old?.id || `claude-custom-${randomUUID()}`,
        name: input.name,
        color: old?.color || "#d97757",
        model: input.model || old?.model || undefined,
        env,
      };
      const next = old
        ? this.records.map((item) => (item.id === old.id ? record : item))
        : [...this.records, record];
      await this.save(next);
      this.records = next;
      return record.id;
    });
  }

  remove(id: string) {
    return this.mutate(async () => {
      if (!this.records.some((record) => record.id === id))
        throw new Error("只能删除 Deck 自定义 Claude 供应商");
      const next = this.records.filter((record) => record.id !== id);
      await this.save(next);
      this.records = next;
    });
  }

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(() => {
      if (this.loadError)
        throw new Error("请先修复 claude-providers.json；不会覆盖损坏的配置");
      return run();
    });
    this.mutations = result.catch(() => undefined);
    return result;
  }

  private async save(records: ProfileRecord[]) {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.file);
  }
}
