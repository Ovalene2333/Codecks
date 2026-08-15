// Compatibility export for existing integrations and tests. New runtime code
// should import CodexAdapter from server/agents/codex-adapter.ts directly.
export {
  CodexAdapter,
  CodexAdapter as CodexManager,
} from "./agents/codex-adapter.js";
