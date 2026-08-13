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

export interface Approval {
  id: string;
  providerId: string;
  request: { method: string; params: any };
}

export interface Snapshot {
  providers: Provider[];
  threads: ThreadSummary[];
  archivedThreads?: ThreadSummary[];
  approvals: Approval[];
  projects?: ProjectRecord[];
  preferences?: DeckPreferences;
  runtime?: {
    online: boolean;
    starting: boolean;
    remoteUrl: string;
    error?: string;
    configPending?: boolean;
  };
}
