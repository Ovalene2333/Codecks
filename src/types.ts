export interface Provider {
  id: string;
  name: string;
  kind: "local-profile" | "custom" | "cc-switch";
  color: string;
  model?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  enabled: boolean;
  online: boolean;
  current?: boolean;
  error?: string;
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
}
export interface Approval {
  id: string;
  providerId: string;
  request: { method: string; params: any };
}
export interface Snapshot {
  providers: Provider[];
  threads: ThreadSummary[];
  approvals: Approval[];
}
