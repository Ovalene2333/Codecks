import { parentPort } from "node:worker_threads";
import { CpuSampler, hostStats } from "./host-stats.js";
import { CcSwitchSource } from "./cc-switch.js";
import { readClaudeHistory } from "./agents/claude-history.js";
import { listCodexBinCandidates } from "./codex-bins.js";
import { listLocalAgentBins } from "./local-agent-bins.js";
import type { BackgroundTask } from "./background-work.js";
let sampler: CpuSampler | undefined;
parentPort!.on("message", async ({ id, task, args }: { id: number; task: BackgroundTask; args: any[] }) => {
  try {
    let value: unknown;
    switch (task) {
      case "host": value = hostStats(sampler ??= new CpuSampler(), args[0], args[1]); break;
      case "cc": {
        const source = new CcSwitchSource(args[0]);
        value = { providers: source.readProviders(), profiles: source.readClaudeProfiles() }; break;
      }
      case "history": value = await readClaudeHistory(args[0]); break;
      case "codexBins": value = await listCodexBinCandidates(args[0], args[1], args[2]); break;
      case "agentBins": value = await listLocalAgentBins(args[0], args[1]); break;
      default: throw new Error("Unknown background task");
    }
    parentPort!.postMessage({ id, value });
  } catch (error) { parentPort!.postMessage({ id, error: (error as Error).message }); }
});
