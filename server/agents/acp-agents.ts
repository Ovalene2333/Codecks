import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AcpAgentSpec } from "./acp-adapter.js";

/**
 * 内置的 ACP agent 描述符。来源：agentclientprotocol.com registry。
 * 每个 agent 只声明启动命令；能力全部从 initialize 响应里探测。
 */
export const BUILTIN_ACP_AGENTS: AcpAgentSpec[] = [
  {
    id: "devin",
    name: "Devin",
    command: "devin",
    args: ["acp"],
    env: {},
    listSessions: {
      args: ["list", "--format", "json"],
      perDirectory: true,
    },
  },
  {
    id: "kimi",
    name: "Kimi",
    command: "kimi",
    args: ["acp"],
    listSessions: {
      args: ["list", "--format", "json"],
      perDirectory: true,
    },
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose",
    args: ["acp"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    command: "copilot",
    args: ["--acp"],
  },
  {
    id: "droid",
    name: "Factory Droid",
    command: "droid",
    args: ["exec", "--output-format", "acp-daemon"],
  },
];

const SPEC_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function envRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    if (typeof item === "string") out[key] = item;
  return out;
}

function normalizeSpec(raw: unknown, source: string): AcpAgentSpec | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const id = String(row.id || "").trim();
  if (!SPEC_ID_RE.test(id)) return undefined;
  if (id === "codex" || id === "claude" || id === "opencode") return undefined;
  const command = String(row.command || "").trim();
  if (!command) return undefined;
  const spec: AcpAgentSpec = {
    id,
    name: String(row.name || id),
    command,
    args: Array.isArray(row.args) ? row.args.map(String) : undefined,
    env: envRecord(row.env),
    enabled: row.enabled !== false,
  };
  const list = row.listSessions;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    const item = list as Record<string, unknown>;
    const args = Array.isArray(item.args) ? item.args.map(String) : [];
    if (args.length)
      spec.listSessions = {
        command:
          typeof item.command === "string" && item.command.trim()
            ? item.command.trim()
            : undefined,
        args,
        perDirectory: item.perDirectory === true,
      };
  }
  const models = Array.isArray(row.models) ? row.models : [];
  spec.models = models
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      id: String(item.id || item.model || ""),
      name: item.name,
      description: item.description,
    }))
    .filter((item) => item.id);
  void source;
  return spec;
}

/**
 * 读取 `{dataDir}/acp-agents.json` 的用户自定义 agent：
 * - 与内置同 id → 覆盖字段（command/args/env/listSessions…）
 * - 新 id → 注册为新的 ACP agent
 * 文件格式与 BUILTIN_ACP_AGENTS 相同，为 AcpAgentSpec 数组。
 */
export async function loadAcpAgentSpecs(
  dataDir: string,
): Promise<AcpAgentSpec[]> {
  const specs = new Map<string, AcpAgentSpec>();
  for (const spec of BUILTIN_ACP_AGENTS) specs.set(spec.id, { ...spec });
  const file = path.join(dataDir, "acp-agents.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      const list = Array.isArray(raw) ? raw : raw?.agents;
      if (Array.isArray(list)) {
        for (const entry of list) {
          const spec = normalizeSpec(entry, file);
          if (!spec) continue;
          const existing = specs.get(spec.id);
          specs.set(spec.id, existing ? { ...existing, ...spec } : spec);
        }
      }
    } catch {
      // 配置文件损坏时静默忽略：内置 agent 仍可用。
    }
  }
  return [...specs.values()].filter((spec) => spec.enabled !== false);
}

/** 生成一份示例配置，便于用户照着改。仅在文件不存在时创建。 */
export async function ensureAcpAgentsExample(dataDir: string) {
  const file = path.join(dataDir, "acp-agents.example.json");
  if (existsSync(file)) return;
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        {
          agents: [
            {
              id: "my-agent",
              name: "My ACP Agent",
              command: "my-agent",
              args: ["acp"],
              env: {},
              listSessions: {
                args: ["sessions", "--format", "json"],
                perDirectory: true,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    /* 示例文件写失败不影响功能 */
  }
}
