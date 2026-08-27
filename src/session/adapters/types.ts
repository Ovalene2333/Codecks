import type { ReactNode } from "react";
import type { ThreadSummary } from "../../types";

export interface AgentItemContext {
  thread: ThreadSummary;
}

/**
 * Per-agent frontend adapter. `renderItem` opts in to rendering items the
 * core renderer does not understand (extension items, agent-specific tool
 * payloads). Returning `undefined` falls through to the built-in renderers,
 * with UnknownItem as the final fallback.
 */
export interface AgentUiAdapter {
  renderItem?(item: any, context: AgentItemContext): ReactNode | undefined;
}
