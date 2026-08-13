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

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string; data?: any };
}
