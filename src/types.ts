/**
 * Stable agent identifier. Built-in adapters use codex/claude/opencode; ACP
 * agents get arbitrary ids from their descriptors.
 */
export type AgentId = string;

export interface Provider {
  id: string;
  name: string;
  kind: "local-profile" | "custom" | "cc-switch";
  color: string;
  model?: string;
  baseUrl?: string;
  wireApi?: "responses" | "chat";
  hasApiKey: boolean;
  enabled: boolean;
  online: boolean;
  starting?: boolean;
  current?: boolean;
  error?: string;
}

export type SandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ApprovalsReviewer = "user" | "auto_review";
export type ApprovalMode = ApprovalPolicy | "auto-review";
export type Personality = "friendly" | "pragmatic" | "none";
export type ClaudePermissionMode =
  "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

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

export interface FileChange {
  path: string;
  kind?: string;
  diff?: string;
}

/**
 * Native item that has no Codex-shaped equivalent (OpenCode todo parts,
 * Claude TodoWrite snapshots, ...). Rendered by per-agent frontend adapters
 * under src/session/adapters; unknown kinds fall back to a collapsed view.
 */
export interface TurnExtensionItem {
  id: string;
  type: "extension";
  kind: string;
  agentId?: AgentId;
  status?: "inProgress" | "completed" | "failed";
  payload?: unknown;
}

export interface ApprovalQuestion {
  id?: string;
  prompt?: string;
  header?: string;
  question?: string;
  options?: {
    label: string;
    value?: string;
    description?: string;
    isOther?: boolean;
  }[];
  isOther?: boolean;
  multiple?: boolean;
  custom?: boolean;
}

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
  /** The upstream provider of this model is logged in / usable right now. */
  connected?: boolean;
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

export interface ThreadSummary {
  agentId?: AgentId;
  id: string;
  providerId: string;
  name: string;
  preview: string;
  cwd: string;
  model: string;
  /**
   * Concrete model the agent actually ran with, resolved from its own history
   * (for example `anthropic/claude-sonnet-4-5`) when `model` is a placeholder
   * such as OpenCode's `default`. Display only — `model` stays the setting.
   */
  resolvedModel?: string;
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
  sessionMode?: string;
  sessionModes?: { id: string; name?: string; description?: string }[];
  tokenUsage?: TokenUsage;
  /** Turn that was in progress when the Codex runtime process died. */
  interruptedTurnId?: string;
  compacting?: boolean;
  migratedFrom?: { providerId: string; threadId: string };
  controlMode?: "managed" | "history";
  /** Claude SDK process remains connected between turns. */
  claudeConnected?: boolean;
  /** 会话被其它进程占用（ACP session lock），只能查看缓存历史。 */
  locked?: boolean;
}

export interface SessionSearchMatch {
  agentId: AgentId;
  threadId: string;
  turnId?: string;
  itemId?: string;
  role: "user" | "assistant";
  snippet: string;
  score: number;
}

export interface SessionSearchResponse {
  results: SessionSearchMatch[];
  indexed: number;
  total: number;
  building: boolean;
}

export interface ActiveTaskCommand {
  itemId?: string;
  processId?: string;
  command: string;
  cwd?: string;
  osPid?: number | null;
  cpuPercent?: number | null;
  rssKb?: number | null;
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

/** 与 server/types.ts 同形：监控台的实时活动（见 server/activity.ts）。 */
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
  turnStartedAt?: number;
  lastEventAt: number;
  step?: { item: ActivityItem; startedAt: number };
  lastTurn?: { startedAt: number; endedAt: number; status: string };
}

export interface ActivityUpdate {
  agentId: AgentId;
  threadId: string;
  activity: ThreadActivity | null;
}

export interface HostStats {
  platform: string;
  arch: string;
  cpuCount: number;
  cpuPercent?: number;
  loadavg: number[];
  memTotal: number;
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

export interface ApprovalResolveBody {
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  /** ACP：直接选中 agent 给出的某个 optionId（devin 一次给多档选项）。 */
  optionId?: string;
  permissions?: unknown;
  scope?: "session" | "turn";
  answers?: unknown;
}

export interface Approval {
  id: string;
  agentId?: AgentId;
  providerId: string;
  request: { method: string; params: any };
  kind?: ApprovalKind;
  cwd?: string;
  command?: string;
  reason?: string;
  changes?: FileChange[];
  questions?: ApprovalQuestion[];
  multiple?: boolean;
  availableDecisions?: string[];
  permissions?: unknown;
  itemId?: string;
  networkApproval?: boolean;
}

export interface RuntimeSnapshot {
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

export interface AgentCapabilities {
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
  /** native=CLI 私有协议 adapter；acp=Agent Client Protocol 通用接入。 */
  protocol?: "native" | "acp";
  /**
   * 备选 agent：与该主 agent 共用同一份会话存储。主 agent 可用时服务端
   * 不再重复下发它的历史会话；主 agent 不可用时自动顶上。
   */
  fallbackFor?: AgentId;
  /** 备选 agent 正在待命：服务端已隐藏它的历史会话，本地缓存的旧副本应丢弃。 */
  standby?: boolean;
  /** 是否被加载；缺省（旧服务端）视为 true。false 时不启动、不下发会话。 */
  enabled?: boolean;
  /** 能否在设置里停用；Codex 是核心 agent，不可停用。缺省视为 true。 */
  toggleable?: boolean;
  /** enabled=false 的原因：`user` 用户停用；`default` 默认策略不加载。 */
  disabledReason?: "user" | "default";
  /** 默认策略不加载的说明，如「未检测到 kimi 命令」。 */
  defaultNote?: string;
  available: boolean;
  online: boolean;
  starting?: boolean;
  error?: string;
  historyStatus?: "cached" | "loading" | "ready" | "error";
  historyError?: string;
  capabilities: AgentCapabilities;
}

/** `PUT /agents/:id/enabled` 的结果；applied=false 表示有会话在运行、需要 force。 */
export interface AgentToggleResponse {
  applied: boolean;
  changed: boolean;
  busyCount: number;
  snapshot: Snapshot;
}

export interface AgentReloadResult {
  id: AgentId;
  /** 有会话在运行且没有 force 时为 false。 */
  reloaded: boolean;
  busyCount: number;
  error?: string;
}

export interface AgentReloadResponse {
  result: AgentReloadResult;
  snapshot: Snapshot;
}

export interface AgentsReloadResponse {
  sync: {
    added: AgentId[];
    removed: AgentId[];
    replaced: AgentId[];
    skippedBusy: AgentId[];
  };
  results: AgentReloadResult[];
  snapshot: Snapshot;
}

export interface AgentProfile {
  id: string;
  agentId: AgentId;
  name: string;
  color?: string;
  current?: boolean;
  official?: boolean;
  enabled?: boolean;
  online?: boolean;
  /** Logged in / usable in the upstream agent (OpenCode `connected`). */
  connected?: boolean;
}

export interface Snapshot {
  agents?: AgentDescriptor[];
  agentProfiles?: AgentProfile[];
  providers: Provider[];
  threads: ThreadSummary[];
  archivedThreads?: ThreadSummary[];
  approvals: Approval[];
  activities?: ThreadActivity[];
  projects?: ProjectRecord[];
  preferences?: DeckPreferences;
  runtime?: RuntimeSnapshot;
}
