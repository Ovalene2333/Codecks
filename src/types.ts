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

export interface ApprovalQuestion {
  id?: string;
  prompt?: string;
  header?: string;
  question?: string;
  options?: { label: string; value?: string; isOther?: boolean }[];
  isOther?: boolean;
}

export interface ConnectionOverlay {
  requestMaxRetries?: number | null;
  streamMaxRetries?: number | null;
  streamIdleTimeoutMs?: number | null;
}

export interface ProjectDefaults extends ConnectionOverlay {
  agentId?: "codex" | "claude";
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
  lastAgentId?: "codex" | "claude";
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
  agentId?: "codex" | "claude";
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
  compacting?: boolean;
  migratedFrom?: { providerId: string; threadId: string };
  controlMode?: "managed" | "history";
}

export interface SessionSearchMatch {
  agentId: "codex" | "claude";
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
  agentId: "codex" | "claude";
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

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  icon: string;
  available: boolean;
  unavailableReason?: string;
  pagePath?: string;
  defaultCwd?: string;
}

export interface ApprovalResolveBody {
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  permissions?: unknown;
  scope?: "session" | "turn";
  answers?: unknown;
}

export interface Approval {
  id: string;
  agentId?: "codex" | "claude";
  providerId: string;
  request: { method: string; params: any };
  kind?: ApprovalKind;
  cwd?: string;
  command?: string;
  reason?: string;
  changes?: FileChange[];
  questions?: ApprovalQuestion[];
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
  id: "codex" | "claude";
  name: string;
  available: boolean;
  online: boolean;
  starting?: boolean;
  error?: string;
  historyStatus?: "cached" | "loading" | "ready" | "error";
  historyError?: string;
  capabilities: AgentCapabilities;
}

export interface AgentProfile {
  id: string;
  agentId: "codex" | "claude";
  name: string;
  color?: string;
  current?: boolean;
  official?: boolean;
  enabled?: boolean;
  online?: boolean;
}

export interface Snapshot {
  agents?: AgentDescriptor[];
  providers: Provider[];
  threads: ThreadSummary[];
  archivedThreads?: ThreadSummary[];
  approvals: Approval[];
  projects?: ProjectRecord[];
  preferences?: DeckPreferences;
  runtime?: RuntimeSnapshot;
}
