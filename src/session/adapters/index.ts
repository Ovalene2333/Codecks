import type { AgentUiAdapter } from "./types";
import { claudeAdapter } from "./claude";
import { openCodeAdapter } from "./opencode";

const ADAPTERS: Record<string, AgentUiAdapter | undefined> = {
  claude: claudeAdapter,
  opencode: openCodeAdapter,
};

export function uiAdapterFor(agentId?: string) {
  return agentId ? ADAPTERS[agentId] : undefined;
}

export { openCodePartToItem, openCodeTodos, claudeTodos } from "./native-parts";
export type { AgentUiAdapter } from "./types";
