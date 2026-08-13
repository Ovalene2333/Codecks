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

export interface ProjectDefaults {
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

export interface DeckPreferences {
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
  migratedFrom?: { providerId: string; threadId: string };
  controlMode?: "managed" | "history";
}

export interface RuntimeStatus {
  online: boolean;
  starting: boolean;
  remoteUrl: string;
  error?: string;
  configPending?: boolean;
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string; data?: any };
}
