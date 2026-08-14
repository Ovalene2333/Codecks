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
export type Personality = "friendly" | "pragmatic" | "none";

export interface TokenUsage {
  used?: number;
  limit?: number;
  input?: number;
  output?: number;
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
  | "command"
  | "file"
  | "permission"
  | "question"
  | "unknown";

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
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
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
  lastProviderId?: string;
  lastModel?: string;
  lastReasoningEffort?: string;
  lastSandbox?: SandboxMode;
  lastApprovalPolicy?: ApprovalPolicy;
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
}

export interface ThreadSummary {
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
  forkedFromId?: string;
  sessionId?: string;
  tokenUsage?: TokenUsage;
  compacting?: boolean;
  migratedFrom?: { providerId: string; threadId: string };
  controlMode?: "managed" | "history";
}

export interface ApprovalResolveBody {
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  permissions?: unknown;
  scope?: "session" | "turn";
  answers?: unknown;
}

export interface Approval {
  id: string;
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
}

export interface Snapshot {
  providers: Provider[];
  threads: ThreadSummary[];
  archivedThreads?: ThreadSummary[];
  approvals: Approval[];
  projects?: ProjectRecord[];
  preferences?: DeckPreferences;
  runtime?: RuntimeSnapshot;
}
