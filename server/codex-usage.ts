import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseTokenUsage, uncachedInputTokens } from "./protocol.js";
import type { TokenUsage } from "./types.js";

const execFileAsync = promisify(execFile);
const USAGE_FIELDS = [
  "total",
  "used",
  "limit",
  "input",
  "cachedInput",
  "output",
  "reasoningOutput",
] as const;

type UsageField = (typeof USAGE_FIELDS)[number];
type WslExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

function normalizeUsage(
  raw: unknown,
  migrateInclusiveInput = false,
): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage: TokenUsage = {};
  for (const field of USAGE_FIELDS) {
    const value = (raw as Record<UsageField, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      usage[field] = value;
  }
  if (migrateInclusiveInput && usage.input != null)
    usage.input = uncachedInputTokens(
      usage.input,
      usage.cachedInput,
      usage.total,
      usage.output,
    );
  return Object.keys(usage).length ? usage : undefined;
}

export class CodexUsageStore {
  private usage = new Map<string, TokenUsage>();
  private loaded = false;
  private pending: Promise<void> = Promise.resolve();
  private file: string;

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "codex-usage.json");
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      const threads = parsed?.threads || parsed;
      const migrateInclusiveInput = parsed?.version !== 2;
      if (!threads || typeof threads !== "object") return;
      for (const [threadId, raw] of Object.entries(threads)) {
        const usage = normalizeUsage(raw, migrateInclusiveInput);
        if (threadId && usage) this.usage.set(threadId, usage);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }

  get(threadId: string) {
    return this.usage.get(threadId);
  }

  set(threadId: string, usage: TokenUsage) {
    const normalized = normalizeUsage(usage);
    if (!threadId || !normalized) return this.pending;
    this.usage.set(threadId, normalized);
    return this.save();
  }

  setMany(entries: Iterable<readonly [string, TokenUsage]>) {
    let changed = false;
    for (const [threadId, raw] of entries) {
      const usage = normalizeUsage(raw);
      if (!threadId || !usage) continue;
      this.usage.set(threadId, usage);
      changed = true;
    }
    return changed ? this.save() : this.pending;
  }

  remove(threadId: string) {
    if (!this.usage.delete(threadId)) return this.pending;
    return this.save();
  }

  flush() {
    return this.pending;
  }

  private save() {
    const snapshot = Object.fromEntries(this.usage);
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(
          this.file,
          JSON.stringify({ version: 2, threads: snapshot }, null, 2),
          { encoding: "utf8", mode: 0o600 },
        );
      });
    return this.pending;
  }
}

export function parseCodexRolloutUsageLine(line: string) {
  try {
    const record = JSON.parse(line);
    if (record?.type !== "event_msg" || record?.payload?.type !== "token_count")
      return undefined;
    return parseTokenUsage(record.payload.info);
  } catch {
    return undefined;
  }
}

export function threadIdFromRolloutPath(filePath: string) {
  return path
    .basename(filePath)
    .match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    )?.[1];
}

async function latestUsageFromFile(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const chunkSize = 256 * 1024;
    let end = size;
    let carry = "";
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = `${buffer.toString("utf8")}${carry}`.split(/\r?\n/);
      carry = start > 0 ? lines.shift() || "" : "";
      for (let index = lines.length - 1; index >= 0; index--) {
        if (!lines[index].includes('"token_count"')) continue;
        const usage = parseCodexRolloutUsageLine(lines[index]);
        if (usage) return usage;
      }
      end = start;
    }
    return carry.includes('"token_count"')
      ? parseCodexRolloutUsageLine(carry)
      : undefined;
  } finally {
    await handle.close();
  }
}

async function rolloutFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) return rolloutFiles(fullPath);
      return Promise.resolve(
        entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [],
      );
    }),
  );
  return nested.flat();
}

async function loadNativeRolloutUsages(
  codexHome: string,
  wanted?: ReadonlySet<string>,
) {
  const files = (
    await Promise.all([
      rolloutFiles(path.join(codexHome, "sessions")),
      rolloutFiles(path.join(codexHome, "archived_sessions")),
    ])
  ).flat();
  const usage = new Map<string, TokenUsage>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(16, Math.max(1, files.length)) },
    async () => {
      while (cursor < files.length) {
        const filePath = files[cursor++];
        const threadId = threadIdFromRolloutPath(filePath);
        if (!threadId || (wanted && !wanted.has(threadId))) continue;
        const restored = await latestUsageFromFile(filePath);
        if (restored) usage.set(threadId, restored);
      }
    },
  );
  await Promise.all(workers);
  return usage;
}

export const WSL_CODEX_USAGE_WORKER = [
  "    for file do",
  "      if command -v tac >/dev/null 2>&1; then",
  '        line=$(tac -- "$file" 2>/dev/null | grep -m 1 \'"type"[[:space:]]*:[[:space:]]*"token_count"\' || true)',
  "      else",
  '        line=$(awk \'/"type"[[:space:]]*:[[:space:]]*"token_count"/ { line=$0 } END { print line }\' "$file")',
  "      fi",
  '      [ -n "$line" ] || continue',
  '      printf "%s\\t%s\\n" "$file" "$line"',
  "    done",
].join("\n");

export const WSL_CODEX_USAGE_SCRIPT = [
  "home=$1",
  "worker=$2",
  'for root in "$home/sessions" "$home/archived_sessions"; do',
  '  [ -d "$root" ] || continue',
  '  find "$root" -type f -name \'*.jsonl\' -exec sh -c "$worker" codex-usage {} +',
  "done",
].join("\n");

export function wslCodexUsageArgs(codexHome: string) {
  return [
    "--exec",
    "sh",
    "-c",
    WSL_CODEX_USAGE_SCRIPT,
    "codex-usage",
    codexHome,
    WSL_CODEX_USAGE_WORKER,
  ];
}

export function parseWslCodexUsages(
  stdout: string,
  wanted?: ReadonlySet<string>,
) {
  const usage = new Map<string, TokenUsage>();
  for (const row of stdout.replace(/\r\n/g, "\n").split("\n")) {
    const separator = row.indexOf("\t");
    if (separator < 0) continue;
    const threadId = threadIdFromRolloutPath(row.slice(0, separator));
    if (!threadId || (wanted && !wanted.has(threadId))) continue;
    const parsed = parseCodexRolloutUsageLine(row.slice(separator + 1));
    if (parsed) usage.set(threadId, parsed);
  }
  return usage;
}

async function defaultWslExec(command: string, args: string[]) {
  return execFileAsync(command, args, {
    timeout: 120_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16_000_000,
  });
}

export async function loadCodexRolloutUsages(options: {
  codexHome: string;
  useWsl?: boolean;
  wanted?: ReadonlySet<string>;
  wslExec?: WslExec;
}) {
  if (!options.codexHome || /[\0\r\n]/.test(options.codexHome))
    return new Map<string, TokenUsage>();
  if (!options.useWsl)
    return loadNativeRolloutUsages(options.codexHome, options.wanted);
  const { stdout } = await (options.wslExec || defaultWslExec)(
    process.env.WSL_EXE || "wsl.exe",
    wslCodexUsageArgs(options.codexHome),
  );
  return parseWslCodexUsages(stdout, options.wanted);
}
