import type { EventEmitter } from "node:events";
import type {
  ApprovalKind,
  Personality,
  ThreadSummary,
  TurnImage,
} from "../types.js";

export type AgentId = "codex" | "claude";

export interface AgentCapabilities {
  approvals: boolean;
  archive: boolean;
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
  personality?: Personality;
  approvalPolicy?: string;
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
  busyThreads(): ThreadSummary[];
  restart(): void;
  publicProfiles?(): AgentPublicProfile[];
  createThread?(
    providerId: string,
    input: AgentCreateThreadInput,
  ): Promise<unknown>;
  readThread?(providerId: string, threadId: string): Promise<unknown>;
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
}
