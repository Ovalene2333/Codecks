import type { EventEmitter } from "node:events";
import type { ApprovalKind, ThreadSummary } from "../types.js";

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

export interface AgentAdapter extends Pick<EventEmitter, "on"> {
  readonly id: AgentId;
  descriptor(): AgentDescriptor;
  snapshot(): AgentSnapshot;
  startAll(): Promise<void>;
  refreshAll(): Promise<void>;
  busyThreads(): ThreadSummary[];
  restart(): void;
}
