import { parentPort } from "node:worker_threads";
import { CpuSampler, hostStats } from "./host-stats.js";
import { CcSwitchSource } from "./cc-switch.js";
import {
  readClaudeHistory,
  createClaudeHistoryBranch,
} from "./agents/claude-history.js";
import { collectCodexBinCandidates } from "./codex-bins.js";
import { collectLocalAgentBins } from "./local-agent-bins.js";
import { SessionSearchStore } from "./session-search.js";
import type { BackgroundTask } from "./background-work.js";
let sampler: CpuSampler | undefined;
let search: { dir: string; store: SessionSearchStore } | undefined;
parentPort!.on(
  "message",
  async ({
    id,
    task,
    args,
  }: {
    id: number;
    task: BackgroundTask;
    args: any[];
  }) => {
    try {
      let value: unknown;
      switch (task) {
        case "host": {
          const stats = hostStats(
            (sampler ??= new CpuSampler()),
            args[0],
            args[1],
          );
          value = { ...stats, deck: args[2] };
          break;
        }
        case "cc": {
          const source = new CcSwitchSource(args[0], true);
          value = {
            providers: source.readProviders(),
            profiles: source.readClaudeProfiles(),
          };
          break;
        }
        case "search": {
          const [dir, operation, params] = args;
          if (search?.dir !== dir) {
            search?.store.close();
            search = { dir, store: new SessionSearchStore(dir) };
          }
          const store = search!.store;
          switch (operation) {
            case "reconcile":
              store.removeAbsent(params[0]);
              value = params[0].filter((thread: any) =>
                store.needsIndex(thread),
              );
              break;
            case "upsert":
              store.upsert(params[0], params[1]);
              break;
            case "failure":
              store.markFailure(params[0], params[1]);
              break;
            case "search":
              value = store.search(params[0], new Set(params[1]), params[2]);
              break;
            case "count":
              value = store.indexedCount(new Set(params[0]));
              break;
            default:
              throw new Error("Unknown search operation");
          }
          break;
        }
        case "historyBranch":
          value = await createClaudeHistoryBranch(args[0], args[1], args[2]);
          break;
        case "history":
          value = await readClaudeHistory(args[0]);
          break;
        case "codexBins":
          value = collectCodexBinCandidates(args[0], args[1]);
          break;
        case "agentBins":
          value = collectLocalAgentBins(args[0], args[1]);
          break;
        default:
          throw new Error("Unknown background task");
      }
      parentPort!.postMessage({ id, value });
    } catch (error: any) {
      parentPort!.postMessage({
        id,
        error: {
          message: error?.message || "Background task failed",
          code: error?.code,
          statusCode: error?.statusCode,
        },
      });
    }
  },
);
