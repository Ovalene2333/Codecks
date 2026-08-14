export type ProviderKind = "local-profile" | "custom" | "cc-switch";

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
export type Personality = "friendly" | "pragmatic" | "none";

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
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string; data?: any };
}
