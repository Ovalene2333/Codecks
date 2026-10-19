import type { Snapshot } from "./types";

const storage = typeof localStorage === "undefined" ? undefined : localStorage;
let token = storage?.getItem("codex-deck-token") || "";
export const getToken = () => token;
export const setToken = (next: string) => {
  token = next;
  storage?.setItem("codex-deck-token", next);
};

export async function rawApi(url: string, options: RequestInit = {}) {
  return fetch(`/api${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

export async function api<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await rawApi(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

// 首次同步失败时不能无限挂着；超时覆盖响应正文读取，而不只等响应头。
export async function getSnapshot(timeoutMs = 8_000): Promise<Snapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await rawApi("/snapshot", { signal: controller.signal });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || `请求失败 (${response.status})`);
    if (
      !Array.isArray(data.threads) ||
      !Array.isArray(data.providers) ||
      !Array.isArray(data.approvals)
    )
      throw new Error("服务未返回有效会话快照，请检查访问地址或代理配置");
    return data as Snapshot;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("会话同步超时，请检查服务连接后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export const post = <T = any>(url: string, body?: any) =>
  api<T>(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const put = <T = any>(url: string, body?: any) =>
  api<T>(url, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const patch = <T = any>(url: string, body?: any) =>
  api<T>(url, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const remove = <T = any>(url: string, body?: any) =>
  api<T>(url, {
    method: "DELETE",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function getBlob(url: string, signal?: AbortSignal) {
  const response = await fetch(`/api${url}`, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `图片加载失败 (${response.status})`);
  }
  return response.blob();
}

export const pairWithCode = (code: string) =>
  api<{ token: string }>("/pair", {
    method: "POST",
    body: JSON.stringify({ code }),
  });

export async function getHealth() {
  const response = await fetch("/api/health");
  return response.json().catch(() => ({}));
}
