import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildLaneScenarios, laneThreadsFromSummary } from "../server/deck-api-lanes.js";

const DEFAULTS = {
  dataDir: ".data",
  output: ".data/deck-api-swimlanes.json",
  limit: 6,
  maxSteps: 10,
  project: "",
  ask: "",
};

function parseArgs(argv: string[]) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") options.dataDir = argv[++index];
    else if (arg === "--output" || arg === "-o") options.output = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--max-steps") options.maxSteps = Number(argv[++index]);
    else if (arg === "--project") options.project = argv[++index];
    else if (arg === "--ask") options.ask = argv[++index];
    else if (arg === "--help" || arg === "-h") options.dataDir = "";
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const readJson = async (file: string, fallback: unknown) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
};

const options = parseArgs(process.argv.slice(2));
if (!options.dataDir) {
  console.log("用法：node --import tsx scripts/deck-api-session-lanes.ts [--data-dir .data] [--output 文件] [--limit 6] [--max-steps 10] [--project traceroute] [--ask 别名]");
  process.exit(0);
}
if (!Number.isFinite(options.limit) || options.limit < 1) throw new Error("--limit 必须是正整数");
if (!Number.isFinite(options.maxSteps) || options.maxSteps < 3) throw new Error("--max-steps 必须 >= 3");

const dataDir = path.resolve(options.dataDir);
const asks = (await readJson(path.join(dataDir, "ask-sessions.json"), { items: [] })).items || [];
const deliveries = (await readJson(path.join(dataDir, "message-deliveries.json"), { items: [] })).items || [];
const threads = laneThreadsFromSummary(
  await readJson(path.join(dataDir, "thread-summaries.json"), { threads: [], archivedThreads: [] }),
);
const selectedAsks = options.ask
  ? asks.filter((ask: any) => ask.alias === options.ask || ask.id === options.ask)
  : asks;
if (options.ask && !selectedAsks.length) throw new Error(`找不到询问：${options.ask}`);
const result = buildLaneScenarios(selectedAsks, deliveries, threads, {
  limit: options.limit,
  maxSteps: options.maxSteps,
  project: options.project || undefined,
  sanitize: true,
});
result.source = `从 ${path.relative(process.cwd(), dataDir) || dataDir} 的询问台账与消息投递记录解析生成；路径、URL、IP 和令牌已脱敏。${options.ask ? ` 当前只导出询问 ${options.ask}。` : ""}`;
const output = path.resolve(options.output);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`已解析 ${result.scenarios.length} 个实际询问 → ${path.relative(process.cwd(), output)}`);
for (const scenario of result.scenarios) {
  console.log(`- ${scenario.id}  ${scenario.title}  steps=${scenario.steps.length}${scenario.omitted ? `(+${scenario.omitted} 省略)` : ""}  ${scenario.meta.replies} 回传 / ${scenario.meta.failed} 失败`);
}
