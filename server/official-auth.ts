import { readFile } from "node:fs/promises";
import path from "node:path";

export type OfficialAuth = Record<string, unknown>;

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

export async function loadOfficialAuth(input: {
  nativeAuthPath: string;
  ccSwitchDb?: string;
  customApiKeys?: string[];
  existingOfficialAuthPath?: string;
  refreshTokens?: (auth: OfficialAuth) => Promise<OfficialAuth>;
}): Promise<OfficialAuth> {
  const customKeys = new Set(
    (input.customApiKeys || []).map((key) => key.trim()).filter(Boolean),
  );
  const existing = stripCustomKeys(
    await readJson(input.existingOfficialAuthPath || ""),
    customKeys,
  );
  const native = stripCustomKeys(
    await readJson(input.nativeAuthPath),
    customKeys,
  );
  const oauth = input.ccSwitchDb
    ? authFromCcSwitchOAuth(
        await readJson(
          path.join(path.dirname(input.ccSwitchDb), "codex_oauth_auth.json"),
        ),
      )
    : undefined;

  const seed = hasRefreshToken(existing)
    ? existing
    : oauth || (hasRefreshToken(native) ? native : { auth_mode: "chatgpt" });
  if (input.refreshTokens) {
    try {
      return compactOfficialAuth(await input.refreshTokens(seed));
    } catch {
      return compactOfficialAuth(seed);
    }
  }
  return compactOfficialAuth(seed);
}

export function stripCustomKeys(
  auth: OfficialAuth,
  customApiKeys: Set<string>,
): OfficialAuth {
  const next = { ...auth };
  const key = next.OPENAI_API_KEY;
  if (typeof key === "string" && customApiKeys.has(key.trim()))
    delete next.OPENAI_API_KEY;
  return next;
}

export function authFromCcSwitchOAuth(oauth?: OfficialAuth) {
  if (!oauth || typeof oauth !== "object") return undefined;
  const accounts =
    oauth.accounts && typeof oauth.accounts === "object"
      ? (oauth.accounts as Record<string, Record<string, unknown>>)
      : undefined;
  const id =
    typeof oauth.default_account_id === "string"
      ? oauth.default_account_id
      : accounts
        ? Object.keys(accounts)[0]
        : undefined;
  const account = id && accounts ? accounts[id] : undefined;
  const refresh =
    account && typeof account.refresh_token === "string"
      ? account.refresh_token
      : undefined;
  if (!refresh) return undefined;
  const lastRefresh =
    typeof account?.authenticated_at === "string"
      ? account.authenticated_at
      : typeof account?.authenticated_at === "number"
        ? new Date(account.authenticated_at).toISOString()
        : undefined;
  return compactOfficialAuth({
    auth_mode: "chatgpt",
    tokens: {
      account_id:
        (typeof account?.account_id === "string" && account.account_id) || id,
      refresh_token: refresh,
    },
    last_refresh: lastRefresh,
  });
}

export function compactOfficialAuth(auth: OfficialAuth): OfficialAuth {
  const tokens =
    auth.tokens && typeof auth.tokens === "object"
      ? { ...(auth.tokens as Record<string, unknown>) }
      : undefined;
  if (tokens) {
    for (const [key, value] of Object.entries(tokens)) {
      if (value === "" || value == null) delete tokens[key];
    }
  }
  const next: OfficialAuth = { ...auth, auth_mode: "chatgpt" };
  if (tokens && Object.keys(tokens).length) next.tokens = tokens;
  else delete next.tokens;
  return next;
}

export function hasRefreshToken(auth: OfficialAuth) {
  const tokens =
    auth.tokens && typeof auth.tokens === "object"
      ? (auth.tokens as Record<string, unknown>)
      : undefined;
  return typeof tokens?.refresh_token === "string" && Boolean(tokens.refresh_token);
}

export async function refreshChatgptTokens(
  auth: OfficialAuth,
): Promise<OfficialAuth> {
  const tokens =
    auth.tokens && typeof auth.tokens === "object"
      ? { ...(auth.tokens as Record<string, unknown>) }
      : {};
  const refresh =
    typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!refresh) return auth;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
    throw new Error(`无法刷新 OpenAI Official 登录：${detail}`);
  }
  if (typeof payload.access_token === "string")
    tokens.access_token = payload.access_token;
  if (typeof payload.id_token === "string") tokens.id_token = payload.id_token;
  if (typeof payload.refresh_token === "string")
    tokens.refresh_token = payload.refresh_token;
  return {
    ...auth,
    auth_mode: "chatgpt",
    tokens,
    last_refresh: new Date().toISOString(),
  };
}

async function readJson(file: string): Promise<OfficialAuth> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
