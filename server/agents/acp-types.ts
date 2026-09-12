/**
 * Agent Client Protocol（ACP v1）本地类型定义。
 *
 * Deck 是 ACP 的 client 侧：通过 `initialize`/`session/*` 驱动 agent
 * 子进程，并应答 agent 反向发起的 `session/request_permission` 等请求。
 * 只声明用到的字段；未知字段经 `[key: string]: unknown` 原样透传。
 */

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string };
  [key: string]: unknown;
}

export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
}

export interface AcpToolCallContent {
  type: string;
  /** type === "content" 时的内嵌内容块。 */
  content?: AcpContentBlock;
  /** type === "diff" 时的文件差异。 */
  path?: string;
  oldText?: string | null;
  newText?: string;
  /** type === "terminal" 时引用 client 侧终端（Deck 不提供）。 */
  terminalId?: string;
  [key: string]: unknown;
}

export type AcpToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: AcpToolCallStatus | string;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  [key: string]: unknown;
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: any;
}

export interface AcpSessionMode {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue?: unknown;
  /** select 变体：平铺或分组数组。 */
  options?: unknown;
  [key: string]: unknown;
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: {
    list?: unknown;
    delete?: unknown;
    close?: unknown;
    resume?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: { id: string; name?: string; description?: string }[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
  [key: string]: unknown;
}

export interface AcpPromptResult {
  stopReason: string;
  [key: string]: unknown;
}
