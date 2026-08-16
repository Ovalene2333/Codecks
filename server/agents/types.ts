import type { EventEmitter } from "node:events";
import type {
  ApprovalKind,
  BackgroundTerminal,
  ClaudePermissionMode,
  ModelInfo,
  Personality,
  ThreadSummary,
  TurnImage,
} from "../types.js";

export type AgentId = "codex" | "claude";
export type AgentHistoryStatus = "cached" | "loading" | "ready" | "error";

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

export interface AgentAdapter extends Pick<EventEmitter, "on"> {
  readonly id: AgentId;
  descriptor(): AgentDescriptor;
  snapshot(): AgentSnapshot;
  startAll(): Promise<void>;
  refreshAll(): Promise<void>;
  repairHistory?(): Promise<void>;
  busyThreads(): ThreadSummary[];
  restart(): void;
  publicProfiles?(): AgentPublicProfile[];
  listModels?(providerId?: string): Promise<ModelInfo[]> | ModelInfo[];
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
  updateThreadSettings?(
    providerId: string,
    threadId: string,
    settings: Partial<AgentCreateThreadInput>,
  ): Promise<unknown>;
  deleteThread?(providerId: string, threadId: string): Promise<unknown>;
  sendTurn?(
    providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ): Promise<unknown>;
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
}
