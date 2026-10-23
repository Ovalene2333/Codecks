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
  /**
   * true：last* 是用户固定的默认值，新建会话不再回写 last*，也不再自动
   * 给项目记默认值。缺省/false：沿用上次（旧行为）。
   */
  pinDefaults?: boolean;
  /** 已删除会话的别名保留天数；0 表示不回收。 */
  aliasRetentionDays?: number;
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

/**
 * deck 侧投递意图：queue 等对方空闲；steer 若对方正在运行则直接追加到
 * 当前回合（codex turn/steer，不打断），空闲时直接发送；interrupt 先打断
 * 对方当前回合再发送。
 */
export type DeckDeliveryMode = "queue" | "steer" | "interrupt";

export interface AskSession {
  unread?: boolean;
  waitingReason?: "waiting-approval" | "backend-offline" | "unresolved" | "stalled";
  waitingSince?: number;
  waitingDetail?: string;
  lastProgressAt?: number;
  /** 独立执行，正常结束与失败都不自动通知来源；仍允许显式 send。 */
  detached?: boolean;
  resultAvailable?: boolean;
  /** 执行完成与最终文本交付分开记录；empty 不表示执行失败。 */
  resultState?: "pending" | "ready" | "empty";
  captureError?: string;
  currentTurnSentCount?: number;
  currentTurnDeliveredCount?: number;
  /** 只列绑定来源的主动消息；显式 --to 通过 deliveryId 查询投递。 */
  outgoingMessages?: {
    id: string;
    turnId?: string;
    deliveryId?: string;
    mode: DeckDeliveryMode;
    status: "pending" | "unknown" | "queued" | "interrupting" | "sending" | "delivered" | "failed";
    error?: string;
  }[];
  sentCount?: number;
  id: string;
  /** 稳定短别名：由 id 派生后落盘，消息头与 --to @alias 使用。 */
  alias?: string;
  /**
   * 目标会话自己的稳定短别名（`s-…`）。与会话摘要上的 `thread.alias`
   * 取同一份台账，询问卡片用它显示「会话别名」，避免两条通道显示不一致。
   */
  targetAlias?: string;
  sourceAgentId: AgentId;
  sourceThreadId: string;
  sourceProviderId?: string;
  returnMode: DeckDeliveryMode;
  status: "creating" | "queued" | "running" | "answered" | "completed" | "failed" | "cancelled";
  error?: string;
  /** 已主动停止的时间；中止不会向来源自动发消息。 */
  cancelledAt?: number;
  /** 最近一次停止请求的时间；after-turn 模式下会先等当前回合收尾。 */
  cancelRequestedAt?: number;
  /** 已归档时间；归档仍保留原生会话与别名。 */
  archivedAt?: number;
  /** 已删除时间；记录作为墓碑保留，别名永不复用。 */
  deletedAt?: number;
}

/**
 * 会话所在工作区的 Git 状态（只读）。Deck 不管理分支，只把「当前在哪条
 * 分支 / 是不是独立 worktree」暴露出来，避免多个会话在同一 checkout 上
 * 互不知情地互相踩。
 */
export interface GitContext {
  available: boolean;
  /** 当前分支名；detached HEAD 时为空。 */
  branch?: string;
  /** 是否处于 detached HEAD（Codex/Claude worktree 的默认形态）。 */
  detached?: boolean;
  /** 仓库根目录。 */
  root?: string;
  /** 当前目录对应的 worktree 路径。 */
  worktree?: string;
  /** 是否为 linked worktree（不是主 checkout）。 */
  linked?: boolean;
  /** 不可用原因：not-repository / no-cwd / error / disabled。 */
  reason?: "not-repository" | "no-cwd" | "error" | "disabled";
  error?: string;
}

export interface ThreadSummary {
  ask?: AskSession;
  /** 每个可见会话自动分配的稳定短别名，例如 `@s-3f9kq2pz`。 */
  alias?: string;
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
  settingsDeferred?: boolean;
  personality?: Personality;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  permissionMode?: ClaudePermissionMode;
  serviceTier?: string;
  forkedFromId?: string;
  /**
   * 分支创建那一刻的累计用量基线（父会话当时的原生累计值）。分支会话的
   * 累计值包含复制来的历史，统计时用「本会话累计 - 基线」得到它自己新增
   * 的部分，多个分支同时活动也不会重复计费。旧分支没有基线，沿用估算。
   */
  forkUsageBaseline?: TokenUsage;
  /** 会话所在工作区的 Git 状态（只读展示用，服务端探测后下发）。 */
  git?: GitContext;
  sessionId?: string;
  tokenUsage?: TokenUsage;
  /**
   * 供应商原生上报的会话累计用量（例如 OpenCode session.tokens）。存在时
   * 覆盖 tokenUsage 的“最新一步”口径，供用量统计与费用估算使用。
   */
  tokenUsageTotal?: TokenUsage;
  /**
   * Concrete model the agent actually ran with, resolved from its own history
   * when `model` is a placeholder such as OpenCode's `default`.
   */
  resolvedModel?: string;
  /** 服务端已知的模型展示名（如 `GLM-5.3-Flash`）。缺省时客户端用目录兜底。 */
  modelLabel?: string;
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
  /** Codex 多代理：subAgentActivity 的 kind 与 agentPath、collab 的 prompt。 */
  kind?: string;
  agentPath?: string;
  prompt?: string;
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
  lastTurn?: {
    startedAt: number;
    endedAt: number;
    status: string;
    /** 这一轮最后一条回复的开头（约 240 字），首页“新回复”据此预览；仅内存。 */
    reply?: string;
  };
}

/** 本机正在运行的 deck-wake watcher（只读发现，Deck 不托管其生命周期）。 */
export interface WakeWatcher {
  pid: number;
  /** 目标会话别名；沿用持久化字段名，已不再分配独立唤醒代号。 */
  code: string;
  mode: "watch" | "poll";
  label: string;
  /** 被执行的命令（watch：阻塞到任务结束；poll：打印任务状态）。 */
  command: string;
  intervalSec?: number;
  startedAt: number;
  /** poll：日志里最近一次状态（如 RUNNING）及其时间。 */
  state?: string;
  stateAt?: number;
  /** poll：正处于连续连接失败（满 10 次 watcher 报错退出）。 */
  failures?: number;
  log?: string;
  /** 别名对应的会话；旧 watcher 或会话不存在时为空。 */
  agentId?: AgentId;
  threadId?: string;
}

/**
 * 失联的 watcher：进程已经不在，日志里却没有「已唤醒」或「已停止」——
 * 被 kill、机器重启、OOM 等。远端任务可能仍在跑，但不会再有人叫醒会话，
 * 需要人在首页处理（通知会话或忽略）。持久化在 wake-watchers.json。
 */
export interface LostWakeWatcher extends WakeWatcher {
  id: string;
  /** Deck 发现它消失的时间。 */
  endedAt: number;
  reason: string;
  /** 日志最后一行（便于判断死在哪一步）。 */
  lastLine?: string;
}

/**
 * 唤醒投递条目（服务端持久化在 wake-outbox.json，经 snapshot 下发）。
 * pending 仍在重试；delivered 已送达（去重窗口内保留）；dead 投递无望、
 * 等人在首页处理（重试或移除）。preview 是 prompt 详情的截断摘要。
 */
export interface WakeDelivery {
  mode?: DeckDeliveryMode;
  id: string;
  code: string;
  status: "pending" | "delivered" | "dead";
  /** 入队时的目标快照；会话之后删除也不影响展示定位。 */
  agentId: AgentId;
  threadId: string;
  /** 本轮投递已失败次数。 */
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  deliveredAt?: number;
  lastError?: string;
  preview: string;
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
  /** 各已启用 agent 的后端进程（codex app-server、opencode、ACP agent 等）。 */
  servers?: { agentId: AgentId; pid: number; rss?: number }[];
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
  /** 官方帐号每天消耗的 token（`YYYY-MM-DD` -> tokens），不用于周期额度估算。 */
  accountUsageDaily?: Record<string, number>;
  /** 同一重置周期内配对观测的用量与百分比增量。 */
  accountQuotaSamples?: {
    stageTokens: number;
    stageCost: number;
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number;
  }[];
  archiveError?: string;
  runtimeWsl?: boolean;
  modelConfig?: RuntimeModelConfig;
  /** 正在运行的 Runtime 实际用的上下文配置（仅在线时有）。 */
  modelConfigRunning?: RuntimeModelConfig;
  /** 已保存的上下文配置与运行中的不一致，重启后生效。 */
  modelConfigPending?: boolean;
  /** 生效的后端二进制（`codex` 表示 PATH 默认）。 */
  codexBin?: string;
  /** 环境变量是否钉死了后端（此时设置页选择不生效）。 */
  codexBinPinned?: boolean;
  codexBinRunning?: string;
  codexVersionRunning?: string;
  codexVersionSelected?: string;
  codexVersionMismatch?: { running: string; selected: string };
  /** 上个 Deck 进程留下的后端（只提示、不自动杀）。 */
  staleBackend?: { pid: number; codexBin?: string; codexVersion?: string };
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string; data?: any };
}
