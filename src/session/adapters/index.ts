import type { AgentUiAdapter } from "./types";
import { acpAdapter } from "./acp";
import { claudeAdapter } from "./claude";
import { openCodeAdapter } from "./opencode";

const ADAPTERS: Record<string, AgentUiAdapter | undefined> = {
  claude: claudeAdapter,
  opencode: openCodeAdapter,
};

/**
 * codex/claude/opencode 各有专属 adapter；其余动态注册的 agent（ACP）一律
 * 落到通用 adapter，避免每个 CLI 都要写一份渲染层。
 */
export function uiAdapterFor(agentId?: string) {
  if (!agentId || agentId === "codex") return undefined;
  return ADAPTERS[agentId] || acpAdapter;
}

export { openCodePartToItem, openCodeTodos, claudeTodos } from "./native-parts";
export type { AgentUiAdapter } from "./types";
