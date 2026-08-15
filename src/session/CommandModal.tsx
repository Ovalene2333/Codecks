import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { APPROVAL_OPTIONS, SANDBOX_OPTIONS } from "../codexLabels";
import { ModelPicker } from "../ModelPicker";
import type { ApprovalPolicy, SandboxMode, ThreadSummary } from "../types";
import { Modal } from "../ui";

export type CommandModalKind =
  | { kind: "model" }
  | { kind: "permissions" }
  | { kind: "skills"; query: string }
  | { kind: "mention"; query: string }
  | { kind: "mcp"; verbose: boolean };

const titles: Record<CommandModalKind["kind"], string> = {
  model: "模型与推理强度",
  permissions: "权限与审批",
  skills: "可用 Skills",
  mention: "引用工作区文件",
  mcp: "MCP 服务器",
};

export function CommandModal({
  mode,
  thread,
  locked,
  onSettings,
  onInsert,
  onClose,
}: {
  mode: CommandModalKind;
  thread: ThreadSummary;
  locked: boolean;
  onSettings: (settings: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
  }) => Promise<boolean>;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={titles[mode.kind]}
      className="command-modal"
      onClose={onClose}
    >
      {mode.kind === "model" && (
        <ModelCommand
          thread={thread}
          locked={locked}
          onSettings={onSettings}
          onClose={onClose}
        />
      )}
      {mode.kind === "permissions" && (
        <PermissionsCommand
          thread={thread}
          locked={locked}
          onSettings={onSettings}
          onClose={onClose}
        />
      )}
      {mode.kind === "skills" && (
        <SkillsCommand
          thread={thread}
          initialQuery={mode.query}
          onInsert={onInsert}
        />
      )}
      {mode.kind === "mention" && (
        <MentionCommand
          thread={thread}
          initialQuery={mode.query}
          onInsert={onInsert}
        />
      )}
      {mode.kind === "mcp" && (
        <McpCommand thread={thread} verbose={mode.verbose} />
      )}
    </Modal>
  );
}

function ModelCommand({ thread, locked, onSettings, onClose }: any) {
  const [next, setNext] = useState({
    model: thread.model,
    reasoningEffort: thread.reasoningEffort || "",
  });
  return (
    <div className="form command-form">
      <ModelPicker
        providerId={thread.providerId}
        model={next.model}
        reasoningEffort={next.reasoningEffort}
        disabled={locked}
        onChange={setNext}
      />
      {locked && <p className="command-help">任务结束后才能修改模型。</p>}
      <button
        type="button"
        className="primary"
        disabled={locked || !next.model}
        onClick={async () => {
          if (await onSettings(next)) onClose();
        }}
      >
        应用
      </button>
    </div>
  );
}

function PermissionsCommand({ thread, locked, onSettings, onClose }: any) {
  const [sandbox, setSandbox] = useState<SandboxMode>(
    thread.sandbox || "workspace-write",
  );
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    thread.approvalPolicy || "on-request",
  );
  return (
    <div className="form command-form">
      <label>
        Sandbox
        <select
          value={sandbox}
          disabled={locked}
          onChange={(event) => setSandbox(event.target.value as SandboxMode)}
        >
          {SANDBOX_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Approval policy
        <select
          value={approvalPolicy}
          disabled={locked}
          onChange={(event) =>
            setApprovalPolicy(event.target.value as ApprovalPolicy)
          }
        >
          {APPROVAL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {locked && <p className="command-help">任务结束后才能修改权限。</p>}
      <button
        type="button"
        className="primary"
        disabled={locked}
        onClick={async () => {
          if (await onSettings({ sandbox, approvalPolicy })) onClose();
        }}
      >
        应用
      </button>
    </div>
  );
}

function SkillsCommand({ thread, initialQuery, onInsert }: any) {
  const [query, setQuery] = useState(initialQuery);
  const { data, loading, error } = useCommandData<any>(
    `/threads/${thread.providerId}/${thread.id}/skills`,
  );
  const skills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (Array.isArray(data?.skills) ? data.skills : []).filter(
      (skill: any) =>
        !needle ||
        `${skill.name} ${skill.description}`.toLowerCase().includes(needle),
    );
  }, [data, query]);
  return (
    <CommandListState loading={loading} error={error} empty={!skills.length}>
      <input
        autoFocus
        className="command-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索 Skill"
      />
      <div className="command-list">
        {skills.map((skill: any) => (
          <button
            type="button"
            key={`${skill.scope}:${skill.path}:${skill.name}`}
            disabled={!skill.enabled}
            onClick={() => onInsert(`$${skill.name} `)}
          >
            <b>${skill.name}</b>
            <span>{skill.description || "无说明"}</span>
            <small>{skill.enabled ? skill.scope || "skill" : "已停用"}</small>
          </button>
        ))}
      </div>
    </CommandListState>
  );
}

function MentionCommand({ thread, initialQuery, onInsert }: any) {
  const [query, setQuery] = useState(initialQuery);
  const url = `/threads/${thread.providerId}/${thread.id}/files?q=${encodeURIComponent(query)}`;
  const { data, loading, error } = useCommandData<any[]>(url, 160);
  const files = Array.isArray(data) ? data : [];
  return (
    <CommandListState loading={loading} error={error} empty={!files.length}>
      <input
        autoFocus
        className="command-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="输入文件名或路径"
      />
      <div className="command-list">
        {files.map((file) => {
          const mention = mentionPath(file.root, file.path);
          return (
            <button
              type="button"
              key={`${file.root}:${file.path}`}
              onClick={() => onInsert(`@${mention} `)}
            >
              <b>{file.fileName || mention.split("/").at(-1)}</b>
              <span>{mention}</span>
            </button>
          );
        })}
      </div>
    </CommandListState>
  );
}

function McpCommand({ thread, verbose }: any) {
  const { data, loading, error } = useCommandData<any[]>(
    `/threads/${thread.providerId}/${thread.id}/mcp${verbose ? "?verbose=1" : ""}`,
  );
  const servers = Array.isArray(data) ? data : [];
  return (
    <CommandListState loading={loading} error={error} empty={!servers.length}>
      <p className="command-help">
        {verbose
          ? "详细模式：显示工具、资源与资源模板。"
          : "输入 /mcp verbose 查看完整资源。"}
      </p>
      <div className="mcp-list">
        {servers.map((server) => {
          const tools = Object.keys(server.tools || {});
          const resources = Array.isArray(server.resources)
            ? server.resources
            : [];
          const templates = Array.isArray(server.resourceTemplates)
            ? server.resourceTemplates
            : [];
          return (
            <details key={server.name} open={servers.length === 1}>
              <summary>
                <b>{server.name}</b>
                <span>
                  {authLabel(server.authStatus)} · {tools.length} tools
                </span>
              </summary>
              <div>
                <p>{tools.length ? tools.join(", ") : "未公布工具"}</p>
                {verbose && resources.length > 0 && (
                  <p>资源：{resources.map(resourceLabel).join(", ")}</p>
                )}
                {verbose && templates.length > 0 && (
                  <p>模板：{templates.map(resourceLabel).join(", ")}</p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </CommandListState>
  );
}

function CommandListState({ loading, error, empty, children }: any) {
  return (
    <div className="command-browser">
      {children}
      {loading && (
        <div className="command-loading" role="status">
          <span className="loading-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          正在读取
        </div>
      )}
      {!loading && error && <p className="error-banner">{error}</p>}
      {!loading && !error && empty && (
        <p className="command-help">没有匹配项。</p>
      )}
    </div>
  );
}

function useCommandData<T>(url: string, delay = 0) {
  const [state, setState] = useState<{
    data?: T;
    loading: boolean;
    error: string;
  }>({ loading: true, error: "" });
  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: "" }));
    const timer = window.setTimeout(() => {
      api<T>(url)
        .then((data) => {
          if (!cancelled) setState({ data, loading: false, error: "" });
        })
        .catch((error) => {
          if (!cancelled)
            setState({ loading: false, error: error?.message || "读取失败" });
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delay, url]);
  return state;
}

function mentionPath(root: string, value: string) {
  const normalizedRoot = String(root || "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  const normalized = String(value || "").replaceAll("\\", "/");
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized.replace(/^\.\//, "");
}

function authLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object")
    return Object.keys(value)[0] || "unknown";
  return "unknown";
}

function resourceLabel(value: any) {
  return String(value?.name || value?.title || value?.uri || "unnamed");
}
