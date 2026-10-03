import type { EventEmitter } from "node:events";
import type { AgentMessageCapabilities, AgentMessageInput, AgentMessageAcceptance } from "./messages.js";
import type {
  AgentId,
  ApprovalKind,
  BackgroundTerminal,
  ClaudePermissionMode,
  ModelInfo,
  Personality,
  ThreadSummary,
  TurnImage,
} from "../types.js";

export type { AgentId };
export type AgentHistoryStatus = "cached" | "loading" | "ready" | "error";

export interface AgentCapabilities {
  /** 缺省表示旧 adapter 未声明通用消息契约。 */
  messages?: AgentMessageCapabilities;
  approvals: boolean;
  archive: boolean;
  delete: boolean;
  fork: boolean;
  images: boolean;
  interrupt: boolean;
  mcp: boolean;
  models: boolean;
  review: boolean;
  sessionSettings: boolean;
  shell: boolean;
  skills: boolean;
}

export interface AgentDescriptor {
  id: AgentId;
  name: string;
  /**
   * 启动协议：`native` = CLI 私有协议 adapter（codex/claude/opencode），
   * `acp` = Agent Client Protocol 通用接入。前端据此给 Agent 选择器分组。
   */
  protocol?: "native" | "acp";
  /**
   * 备选 agent：与 `fallbackFor` 指向的主 agent 共用同一份会话存储（如
   * claude-code-acp 与原生 Claude 都读写 `~/.claude`）。主 agent 健康时，
   * registry 不再重复展示它的历史会话；主 agent 不可用时自动顶上。
   */
  fallbackFor?: AgentId;
  /**
   * 仅由 registry 在下发描述符时填写：主 agent 可用，这个备选 agent 正在待命，
   * 它未接管的历史会话不会出现在快照里（客户端也不应保留本地缓存的旧副本）。
   */
  standby?: boolean;
  /**
   * 仅由 registry 在下发描述符时填写：这个 agent 是否被加载。缺省视为 true。
   * false 时不启动、不下发它的会话，也不再报告运行状态。
   */
  enabled?: boolean;
  /** 仅由 registry 填写：能否在设置里停用（Codex 是核心，不可停用）。缺省视为 true。 */
  toggleable?: boolean;
  /** enabled=false 的原因：`user` 用户在设置里停用；`default` 默认策略不加载。 */
  disabledReason?: "user" | "default";
  /** 默认策略不加载的说明，如「未检测到 kimi 命令」。 */
  defaultNote?: string;
  available: boolean;
  online: boolean;
  starting?: boolean;
  error?: string;
  historyStatus?: AgentHistoryStatus;
  historyError?: string;
  capabilities: AgentCapabilities;
}

export interface AgentApproval {
  id: string;
  agentId: AgentId;
  providerId?: string;
  request: { method?: string; params?: any };
  kind?: ApprovalKind;
  [key: string]: unknown;
}

export interface AgentSnapshot {
  threads: ThreadSummary[];
  archivedThreads?: ThreadSummary[];
  approvals: AgentApproval[];
  runtime?: unknown;
  providers?: unknown[];
}

export interface AgentCreateThreadInput {
  providerId?: string;
  cwd: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  personality?: Personality;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: string;
  /** ACP `session/set_mode` 的 modeId（agent 自定义，非 Claude 枚举）。 */
  sessionMode?: string;
}

export interface AgentPublicProfile {
  id: string;
  agentId: AgentId;
  name: string;
  color?: string;
  current?: boolean;
  enabled?: boolean;
  online?: boolean;
  [key: string]: unknown;
}

export interface AgentCommand {
  name: string;
  description?: string;
}

export interface AgentSkill {
  name: string;
  description?: string;
  path?: string;
  scope?: string;
  enabled?: boolean;
}

export interface AgentRevertSummary {
  messageID: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface AgentAdapter extends Pick<EventEmitter, "on" | "off"> {
  readonly id: AgentId;
  descriptor(): AgentDescriptor;
  snapshot(): AgentSnapshot;
  startAll(): Promise<void>;
  refreshAll(): Promise<void>;
  /**
   * 不重启 Deck 的「重载」：重新读取该 agent 的配置与会话。缺省实现是
   * `restart()`（停后端进程）再 `startAll()`；adapter 若不能安全地停掉
   * 后端（Claude 的长连接会话），提供自己的轻量实现。
   */
  reload?(): Promise<void>;
  repairHistory?(): Promise<void>;
  busyThreads(): ThreadSummary[];
  /**
   * Deck 托管的后端进程 pid（只读）。deck-wake 沿进程树据此判断命令
   * 来自哪个 agent；没有常驻后端或连的是外部服务时返回空。
   */
  runtimePids?(): number[];
  restart(): void;
  publicProfiles?(): AgentPublicProfile[];
  listModels?(
    providerId?: string,
    directory?: string,
  ): Promise<ModelInfo[]> | ModelInfo[];
  createThread?(
    providerId: string,
    input: AgentCreateThreadInput,
  ): Promise<unknown>;
  readThread?(providerId: string, threadId: string): Promise<unknown>;
  renameThread?(
    providerId: string,
    threadId: string,
    name: string,
  ): Promise<unknown>;
  archiveThread?(providerId: string, threadId: string): Promise<unknown>;
  unarchiveThread?(providerId: string, threadId: string): Promise<unknown>;
  updateThreadSettings?(
    providerId: string,
    threadId: string,
    settings: Partial<AgentCreateThreadInput>,
  ): Promise<unknown>;
  deleteThread?(
    providerId: string,
    threadId: string,
    options?: { closeConnection?: boolean },
  ): Promise<unknown>;
  sendTurn?(
    providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ): Promise<unknown>;
  sendMessage?(
    providerId: string,
    threadId: string,
    input: AgentMessageInput,
  ): Promise<AgentMessageAcceptance>;
  /** 摘要已空闲时，adapter 是否也已完成上一个回合的清理。 */
  messageReady?(threadId: string): boolean;
  /** 即时反馈先于原有内存队列执行；释放后继续原来的 FIFO。 */
  holdMessageQueue?(threadId: string): () => void;
  interrupt?(
    providerId: string,
    threadId: string,
    turnId: string,
  ): Promise<unknown>;
  resolveApproval?(
    approvalId: string,
    body:
      | string
      | {
          decision?: string;
          /** ACP：直接选中 agent 给出的 optionId。 */
          optionId?: string;
          permissions?: unknown;
          scope?: "session" | "turn";
          answers?: unknown;
        },
  ): Promise<unknown>;
  backgroundTerminals?(
    providerId: string,
    threadId: string,
  ): Promise<{
    data: BackgroundTerminal[];
    supported: boolean;
    error?: string;
  }>;
  terminateBackgroundTerminal?(
    providerId: string,
    threadId: string,
    processId: string,
  ): Promise<unknown>;
  listSessionCommands?(
    providerId: string,
    threadId: string,
  ): Promise<AgentCommand[]>;
  listSkills?(
    providerId: string,
    threadId: string,
    forceReload?: boolean,
  ): Promise<{ skills: AgentSkill[]; errors?: unknown[] }>;
  runSessionCommand?(
    providerId: string,
    threadId: string,
    command: string,
    args?: string,
  ): Promise<unknown>;
  compactSession?(providerId: string, threadId: string): Promise<unknown>;
  forkThread?(
    providerId: string,
    threadId: string,
    options?: { messageID?: string; lastTurnId?: string },
  ): Promise<unknown>;
  retryFromTurn?(
    providerId: string,
    threadId: string,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ): Promise<unknown>;
  revertSession?(
    providerId: string,
    threadId: string,
    messageID?: string,
  ): Promise<AgentRevertSummary>;
  unrevertSession?(providerId: string, threadId: string): Promise<{ ok: true }>;
}
