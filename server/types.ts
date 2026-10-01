export type ProviderKind = "local-profile" | "custom" | "cc-switch";

/**
 * Stable agent identifier. Built-in adapters use codex/claude/opencode; ACP
 * adapters register dynamic ids (devin, gemini, ...), so the type stays a
 * plain string rather than a closed union.
 */
export type AgentId = string;

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  color: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  wireApi?: "responses" | "chat";
  codexHome?: string;
  enabled: boolean;
  current?: boolean;
  configToml?: string;
  authJson?: unknown;
}

export type PublicProvider = Omit<
  Provider,
  "apiKey" | "configToml" | "authJson"
> & { hasApiKey: boolean };

export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ApprovalsReviewer = "user" | "auto_review";
export type Personality = "friendly" | "pragmatic" | "none";
export type ClaudePermissionMode =
  "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

export interface ConnectionOverlay {
  requestMaxRetries?: number | null;
  streamMaxRetries?: number | null;
  streamIdleTimeoutMs?: number | null;
}

export interface RuntimeModelConfig {
  modelContextWindow?: number;
  modelAutoCompactTokenLimit?: number;
}

export interface ProjectDefaults extends ConnectionOverlay {
  agentId?: AgentId;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  permissionMode?: ClaudePermissionMode;
}

export interface ProjectRecord {
  key: string;
  cwd: string;
  name?: string;
  pinned?: boolean;
  hidden?: boolean;
  defaults?: ProjectDefaults;
  updatedAt: number;
}

export interface DeckPreferences extends ConnectionOverlay {
  lastAgentId?: AgentId;
  lastProviderId?: string;
  lastModel?: string;
  lastReasoningEffort?: string;
  lastSandbox?: SandboxMode;
  lastApprovalPolicy?: ApprovalPolicy;
  lastApprovalsReviewer?: ApprovalsReviewer;
  lastPermissionMode?: ClaudePermissionMode;
  recentDirs: string[];
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  hidden?: boolean;
  isDefault?: boolean;
  groupName?: string;
  supportsImages?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: {
    reasoningEffort: string;
    description?: string;
  }[];
  supportsPersonality?: boolean;
  serviceTiers?: { id: string; name: string; description?: string }[];
  defaultServiceTier?: string | null;
}

export interface TokenUsage {
  total?: number;
  used?: number;
  limit?: number;
  input?: number;
  cachedInput?: number;
  output?: number;
  reasoningOutput?: number;
}

export interface RateLimitWindow {
  usedPercent?: number;
  used?: number;
  limit?: number;
  resetsAt?: number;
  resetAfterSeconds?: number;
  windowDurationMins?: number;
  reached?: boolean;
}

export interface RateLimits {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  monthly?: RateLimitWindow;
  byLimitId?: Record<string, RateLimitWindow>;
  planType?: string;
  planName?: string;
  resetCredits?: number;
  spendControlReached?: boolean;
  rateLimitReachedType?: string;
}

export interface TurnImage {
  url: string;
  name?: string;
}

export interface ReviewTarget {
  type: "uncommittedChanges" | "baseBranch" | "commit" | "custom";
  branch?: string;
  sha?: string;
  title?: string;
  instructions?: string;
}

export interface AccountInfo {
  authMode?: string;
  planType?: string;
  email?: string;
  chatgpt?: boolean;
}

export type ApprovalKind =
  "command" | "file" | "permission" | "question" | "unknown";

export interface ApprovalQuestion {
  id?: string;
  prompt?: string;
  header?: string;
  question?: string;
  options?: { label: string; value?: string; description?: string; isOther?: boolean }[];
  isOther?: boolean;
  multiple?: boolean;
  custom?: boolean;
}

export interface FileChange {
  path: string;
  kind?: string;
  diff?: string;
}

/**
 * Native item that has no Codex-shaped equivalent (OpenCode todo parts,
 * Claude TodoWrite snapshots, agent-specific tool metadata, ...). The raw
 * payload is preserved so per-agent frontend adapters can render it; agents
 * without an adapter fall back to the generic collapsed view.
 */
export interface TurnExtensionItem {
  id: string;
  type: "extension";
  kind: string;
  agentId?: AgentId;
  status?: "inProgress" | "completed" | "failed";
  payload?: unknown;
}

export interface ThreadSummary {
  agentId?: AgentId;
  id: string;
  providerId: string;
  name: string;
  preview: string;
  cwd: string;
  model: string;
  status: "starting" | "running" | "waiting" | "idle" | "error" | "offline";
  updatedAt: number;
  activeTurnId?: string;
  lastError?: string;
  errorCode?: string;
  archived?: boolean;
  reasoningEffort?: string;
  personality?: Personality;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  permissionMode?: ClaudePermissionMode;
  serviceTier?: string;
  forkedFromId?: string;
  sessionId?: string;
  tokenUsage?: TokenUsage;
  /**
   * Concrete model the agent actually ran with, resolved from its own history
   * when `model` is a placeholder such as OpenCode's `default`.
   */
  resolvedModel?: string;
  /**
   * Turn that was still in progress when the Codex runtime process died.
   * Codex's own state DB has no completion record for it, so refreshes must
   * not promote it back to `running`.
   */
  interruptedTurnId?: string;
  compacting?: boolean;
  migratedFrom?: { providerId: string; threadId: string };
  controlMode?: "managed" | "history";
  /** Claude SDK process remains connected between turns. */
  claudeConnected?: boolean;
  /**
   * 会话被其它进程占用（如 devin 的 session lock）。置位时 Deck 只能展示
   * 缓存历史，load/resume/prompt 会被 agent 拒绝；下一次 session/list
   * 报告未锁定或本进程成功接管后自动清除。
   */
  locked?: boolean;
  /**
   * ACP session mode state（`session/set_mode` 体系，如 devin 的
   * normal/accept-edits/plan/bypass）。与 Claude 的 permissionMode 各自独立。
   */
  sessionMode?: string;
  sessionModes?: { id: string; name?: string; description?: string }[];
}

export interface BackgroundTerminal {
  itemId?: string;
  processId?: string;
  command: string;
  cwd?: string;
  osPid?: number | null;
  cpuPercent?: number | null;
  rssKb?: number | null;
}

export interface ActiveTaskCommand extends BackgroundTerminal {
  status: "running" | "background";
}

export interface ActiveTask {
  id: string;
  agentId: AgentId;
  providerId: string;
  threadId: string;
  threadName: string;
  turnId?: string;
  cwd: string;
  model: string;
  status: "running" | "waiting";
  startedAt: number;
  commands: ActiveTaskCommand[];
  processControl: boolean;
  detailError?: string;
}

/**
 * 监控台用的精简 item：只保留拼一行“正在做什么”所需的字段，
 * 不带输出/diff/大段 input，避免高频广播把快照撑大。
 */
export interface ActivityItem {
  id: string;
  type: string;
  status?: string;
  command?: string;
  tool?: string;
  server?: string;
  title?: string;
  agent?: string;
  activity?: string;
  query?: string;
  path?: string;
  input?: Record<string, string>;
  commandActions?: {
    type: string;
    path?: string;
    query?: string;
    name?: string;
    command?: string;
  }[];
  changes?: { path: string; kind?: string }[];
  changeCount?: number;
}

export interface ThreadActivity {
  agentId: AgentId;
  threadId: string;
  turnId?: string;
  /** 本轮开始时间；Deck 启动前就在跑的回合近似取会话 updatedAt。 */
  turnStartedAt?: number;
  /** 最近一次收到该会话流式事件的时间（心跳节流，精度约 10 秒）。 */
  lastEventAt: number;
  /** 当前进行中的步骤；缺省表示在等模型响应。 */
  step?: { item: ActivityItem; startedAt: number };
  /** 上一轮的起止与结果，空闲会话据此显示上次耗时。 */
  lastTurn?: { startedAt: number; endedAt: number; status: string };
}

export interface ActivityUpdate {
  agentId: AgentId;
  threadId: string;
  /** null = 会话已删除，前端移除对应条目。 */
  activity: ThreadActivity | null;
}

export interface HostStats {
  platform: string;
  arch: string;
  cpuCount: number;
  /** 两次采样间的整机 CPU 占用百分比；首次采样为启动以来均值。 */
  cpuPercent?: number;
  loadavg: number[];
  memTotal: number;
  /** Linux 取 MemAvailable（含可回收缓存），其余平台为 os.freemem()。 */
  memAvailable: number;
  uptimeSec: number;
  deck: {
    pid: number;
    rss: number;
    heapUsed: number;
    uptimeSec: number;
    node: string;
    clients: number;
  };
}

export interface RuntimeStatus {
  online: boolean;
  starting: boolean;
  remoteUrl: string;
  error?: string;
  configPending?: boolean;
  account?: AccountInfo;
  rateLimits?: RateLimits | null;
  rateLimitsError?: string;
  archiveError?: string;
  runtimeWsl?: boolean;
  modelConfig?: RuntimeModelConfig;
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string; data?: any };
}
