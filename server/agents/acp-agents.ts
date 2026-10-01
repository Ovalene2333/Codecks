import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AcpAgentSpec } from "./acp-adapter.js";
import { commandExists } from "./command-exists.js";

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
    authHint: "请先在终端运行 devin auth login 完成登录",
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

/**
 * 把 acp-agents.json 里的一条记录规范化。`base` 是同 id 的内置（或前一条）
 * 描述符：只覆盖用户实际写了的字段，省略 args/env 等不能把它的值冲掉；
 * 覆盖内置 agent 时 command 也可以省略（例如只写 `{id, enabled:false}`）。
 */
function normalizeSpec(
  raw: unknown,
  base?: AcpAgentSpec,
): AcpAgentSpec | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const id = String(row.id || "").trim();
  if (!SPEC_ID_RE.test(id)) return undefined;
  if (id === "codex" || id === "claude" || id === "opencode") return undefined;
  const command = String(row.command || "").trim() || base?.command || "";
  if (!command) return undefined;
  const spec: AcpAgentSpec = { ...base, id, command, name: base?.name ?? id };
  if (typeof row.name === "string" && row.name.trim())
    spec.name = row.name.trim();
  if (Array.isArray(row.args)) spec.args = row.args.map(String);
  if (row.env !== undefined) spec.env = envRecord(row.env);
  // 只保留显式声明：没写 enabled 时由默认策略（是否已安装）决定，见 loadAcpAgentEntries。
  if (typeof row.enabled === "boolean") spec.enabled = row.enabled;
  if (typeof row.authHint === "string" && row.authHint.trim())
    spec.authHint = row.authHint.trim();
  const fallbackFor =
    typeof row.fallbackFor === "string" ? row.fallbackFor.trim() : "";
  if (SPEC_ID_RE.test(fallbackFor) && fallbackFor !== id)
    spec.fallbackFor = fallbackFor;
  const list = row.listSessions;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    const item = list as Record<string, unknown>;
    const args = Array.isArray(item.args) ? item.args.map(String) : [];
    if (args.length) {
      spec.listSessions = {
        command:
          typeof item.command === "string" && item.command.trim()
            ? item.command.trim()
            : undefined,
        args,
        perDirectory: item.perDirectory === true,
      };
      const fields = item.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        const mapped: NonNullable<
          NonNullable<AcpAgentSpec["listSessions"]>["fields"]
        > = {};
        for (const key of [
          "sessionId",
          "cwd",
          "title",
          "updatedAt",
          "locked",
        ] as const) {
          const source = (fields as Record<string, unknown>)[key];
          if (typeof source === "string" && source.trim())
            mapped[key] = source.trim();
        }
        if (Object.keys(mapped).length) spec.listSessions.fields = mapped;
      }
    }
  }
  if (Array.isArray(row.models))
    spec.models = row.models
      .filter((item) => item && typeof item === "object")
      .map((item: any) => ({
        id: String(item.id || item.model || ""),
        name: item.name,
        description: item.description,
      }))
      .filter((item) => item.id);
  return spec;
}

/** 一个可注册的 ACP agent：描述符 + 用户没有显式选择时的默认加载策略。 */
export interface AcpAgentEntry {
  spec: AcpAgentSpec;
  /** 内置描述符（含被用户配置覆盖过的内置 agent）。 */
  builtin: boolean;
  /** 用户没在设置里显式选择时是否加载。 */
  defaultEnabled: boolean;
  /** defaultEnabled 为 false 时的原因，展示在设置页。 */
  defaultNote?: string;
}

/**
 * 读取内置表与 `{dataDir}/acp-agents.json`，返回全部 ACP agent（含默认
 * 不加载的），由调用方按设置决定是否启动：
 * - 与内置同 id → 覆盖用户写了的字段（command/args/env/listSessions…）
 * - 新 id → 注册为新的 ACP agent，默认加载（用户显式声明的）
 * - 配置里 `enabled: false` → 默认不加载；内置 agent 没显式声明时，命令
 *   在 PATH 里找不到就默认不加载（避免监控台里一排「启动失败」）。
 */
export async function loadAcpAgentEntries(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcpAgentEntry[]> {
  const specs = new Map<string, { spec: AcpAgentSpec; builtin: boolean }>();
  for (const spec of BUILTIN_ACP_AGENTS)
    specs.set(spec.id, { spec: { ...spec }, builtin: true });
  const file = path.join(dataDir, "acp-agents.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      const list = Array.isArray(raw) ? raw : raw?.agents;
      if (Array.isArray(list)) {
        for (const row of list) {
          const rowId = String(
            (row as { id?: unknown } | null)?.id || "",
          ).trim();
          const existing = specs.get(rowId);
          const spec = normalizeSpec(row, existing?.spec);
          if (spec)
            specs.set(spec.id, {
              spec,
              builtin: existing?.builtin ?? false,
            });
        }
      }
    } catch {
      // 配置文件损坏时静默忽略：内置 agent 仍可用。
    }
  }
  return [...specs.values()].map(({ spec, builtin }): AcpAgentEntry => {
    if (spec.enabled === false)
      return {
        spec,
        builtin,
        defaultEnabled: false,
        defaultNote: "acp-agents.json 中设为 enabled: false",
      };
    if (
      spec.enabled === undefined &&
      builtin &&
      !commandExists(spec.command, { ...env, ...spec.env })
    )
      return {
        spec,
        builtin,
        defaultEnabled: false,
        defaultNote: `未检测到 ${spec.command} 命令`,
      };
    return { spec, builtin, defaultEnabled: true };
  });
}

/** 兼容入口：只要描述符，不含被配置显式停用的。 */
export async function loadAcpAgentSpecs(
  dataDir: string,
): Promise<AcpAgentSpec[]> {
  return (await loadAcpAgentEntries(dataDir))
    .map((entry) => entry.spec)
    .filter((spec) => spec.enabled !== false);
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
                fields: {
                  sessionId: "session_id",
                  updatedAt: "last_active_at",
                },
              },
              authHint: "请先运行 my-agent login 完成登录",
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
