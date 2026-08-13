import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRightLeft,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Command,
  Folder,
  FolderOpen,
  KeyRound,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api, getSnapshot, getToken, post, remove, setToken } from "./api";
import type {
  Approval,
  ApprovalPolicy,
  ProjectRecord,
  Provider,
  SandboxMode,
  Snapshot,
  ThreadSummary,
} from "./types";
import {
  filterProjectGroups,
  mergeProjectGroups,
  resolveNewThreadDefaults,
} from "./projects";
import { DirBrowser } from "./DirBrowser";
import { ModelPicker } from "./ModelPicker";

const empty: Snapshot = { providers: [], threads: [], approvals: [] };
const fmtTime = (time: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
const basename = (p: string) =>
  p.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || p;

function Status({ status }: { status: ThreadSummary["status"] }) {
  const labels = {
    starting: "启动中",
    running: "运行中",
    waiting: "待确认",
    idle: "空闲",
    error: "异常",
    offline: "离线",
  };
  return (
    <span className={`status ${status}`}>
      <i />
      {labels[status]}
    </span>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose}>
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ProviderModal({
  providers,
  runtime,
  defaultCwd,
  onClose,
  onSaved,
}: {
  providers: Provider[];
  runtime?: Snapshot["runtime"];
  defaultCwd?: string;
  onClose: () => void;
  onSaved: (s: Snapshot) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    wireApi: "responses",
  });
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      onSaved(await post("/providers", { ...form, kind: "custom" }));
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Modal title="供应商与隔离" onClose={onClose}>
      {providers.some((p) => p.kind === "cc-switch") && (
        <div className="sync-note">
          <RefreshCw />
          <div>
            <b>已连接 CC Switch · 只读同步</b>
            <small>
              供应商是 Session 的启动配置；已运行会话不会随 CCS 当前项变化。
            </small>
          </div>
        </div>
      )}
      <div className="provider-list">
        {providers.map((p) => (
          <div className="provider-row" key={p.id}>
            <span
              className="provider-logo"
              style={{ "--color": p.color } as any}
            >
              <Server />
            </span>
            <div>
              <b>
                {p.name}
                {p.current && <mark>当前</mark>}
              </b>
              <small>
                {p.kind === "cc-switch"
                  ? `CC Switch · ${p.baseUrl || "官方登录"}${
                      p.baseUrl && !p.hasApiKey ? " · 无独立 Key" : ""
                    }`
                  : p.kind === "custom"
                    ? `${p.baseUrl} · ${p.wireApi || "responses"}`
                    : "使用当前 Codex 登录"}
              </small>
            </div>
            <span className={runtime?.online ? "online" : "offline-dot"}>
              {runtime?.configPending
                ? "待应用"
                : runtime?.online
                  ? "已装入"
                  : runtime?.starting
                    ? "启动中"
                    : "未装入"}
            </span>
            {runtime?.online && (
              <button
                className="icon-btn"
                type="button"
                title={`复制 ${p.name} 的终端接入命令`}
                onClick={async () => {
                  const query = new URLSearchParams({ providerId: p.id });
                  if (defaultCwd) query.set("cwd", defaultCwd);
                  const result = await api<{ command: string }>(
                    `/runtime/terminal-command?${query}`,
                  );
                  await navigator.clipboard.writeText(result.command);
                }}
              >
                <Command />
              </button>
            )}
            {p.kind === "custom" && (
              <button
                className="icon-btn danger"
                title="删除"
                onClick={async () => {
                  if (confirm(`删除 ${p.name}？现有 Session 历史不会删除。`))
                    onSaved(await remove(`/providers/${p.id}`));
                }}
              >
                <Trash2 />
              </button>
            )}
          </div>
        ))}
      </div>
      {runtime?.configPending && (
        <div className="sync-note pending">
          <RefreshCw />
          <div>
            <b>供应商配置有更新</b>
            <small>所有任务空闲后应用；运行中的 Session 不会被自动中断。</small>
          </div>
          <button
            className="primary"
            onClick={async () =>
              onSaved(await post("/runtime/apply-provider-config"))
            }
          >
            应用
          </button>
        </div>
      )}
      {runtime?.online && (
        <div className="terminal-connect">
          <Command />
          <div>
            <b>从终端接入同一 Runtime</b>
            <small>{runtime.remoteUrl} 仅监听本机，不经过 LAN / CF。</small>
          </div>
          <button
            type="button"
            onClick={async () => {
              const result = await api<{ command: string }>(
                `/runtime/terminal-command${defaultCwd ? `?cwd=${encodeURIComponent(defaultCwd)}` : ""}`,
              );
              await navigator.clipboard.writeText(result.command);
            }}
          >
            复制命令
          </button>
        </div>
      )}
      <form className="form" onSubmit={save}>
        <h3>添加自定义供应商</h3>
        <label>
          显示名称
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：公司网关"
          />
        </label>
        <label>
          Base URL
          <input
            required
            type="url"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <div className="form-grid">
          <label>
            模型
            <input
              required
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="模型 ID"
            />
          </label>
          <label>
            接口
            <select
              value={form.wireApi}
              onChange={(e) => setForm({ ...form, wireApi: e.target.value })}
            >
              <option value="responses">Responses</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
        </div>
        <label>
          API Key
          <input
            required
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="只保存在本机服务端"
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit">
          <Plus />
          添加并连接
        </button>
      </form>
    </Modal>
  );
}

function NewThreadModal({
  providers,
  initialCwd = "",
  project,
  preferences,
  onClose,
  onCreated,
}: {
  providers: Provider[];
  initialCwd?: string;
  project?: ProjectRecord;
  preferences?: Snapshot["preferences"];
  onClose: () => void;
  onCreated: (p: string, id: string) => void;
}) {
  const defaults = resolveNewThreadDefaults({
    cwd: initialCwd,
    project,
    preferences,
    providers,
  });
  const [form, setForm] = useState({
    ...defaults,
    name: "",
    personality: "pragmatic",
  });
  const [browse, setBrowse] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const thread = await post("/threads", form);
      onCreated(form.providerId, thread.id);
      onClose();
    } catch (e: any) {
      setError(e.message);
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <Modal
      title={
        initialCwd ? `在 ${basename(initialCwd)} 中新建会话` : "启动新会话"
      }
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <form className="form" onSubmit={submit}>
        <label>
          供应商
          <select
            value={form.providerId}
            onChange={(e) => setForm({ ...form, providerId: e.target.value })}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <ModelPicker
          providerId={form.providerId}
          model={form.model}
          reasoningEffort={form.reasoningEffort}
          onChange={(next) => setForm((current) => ({ ...current, ...next }))}
        />
        <label>
          工作目录
          <div className="input-action">
            <input
              required
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              placeholder="D:\\Code\\project 或 /mnt/d/Code/project"
            />
            <button
              type="button"
              className="icon-btn"
              title="浏览目录"
              onClick={() => setBrowse(true)}
            >
              <FolderOpen />
            </button>
          </div>
        </label>
        <label>
          会话名称（可选）
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="修复登录问题"
          />
        </label>
        <div className="form-grid">
          <label>
            沙箱
            <select
              value={form.sandbox}
              onChange={(e) =>
                setForm({ ...form, sandbox: e.target.value as SandboxMode })
              }
            >
              <option value="workspace-write">工作区可写</option>
              <option value="read-only">只读</option>
              <option value="danger-full-access">完全访问</option>
            </select>
          </label>
          <label>
            审批策略
            <select
              value={form.approvalPolicy}
              onChange={(e) =>
                setForm({
                  ...form,
                  approvalPolicy: e.target.value as ApprovalPolicy,
                })
              }
            >
              <option value="on-request">按需询问</option>
              <option value="untrusted">严格询问</option>
              <option value="never">不询问</option>
            </select>
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button
          className="primary"
          type="submit"
          disabled={submitting || !form.providerId}
        >
          <Sparkles />
          {submitting ? "正在创建…" : "创建会话"}
        </button>
      </form>
      {browse && (
        <DirBrowser
          initialPath={form.cwd || preferences?.recentDirs?.[0]}
          onClose={() => setBrowse(false)}
          onSelect={(cwd) => {
            setForm((current) => ({ ...current, cwd }));
            setBrowse(false);
          }}
        />
      )}
    </Modal>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (id: string, d: string) => void;
}) {
  const p = approval.request.params || {};
  const isFile = approval.request.method.includes("fileChange");
  return (
    <article className="approval-card">
      <div className="approval-title">
        <ShieldAlert />
        <div>
          <b>{isFile ? "Codex 请求修改文件" : "Codex 请求执行命令"}</b>
          <small>{p.reason || p.cwd || "需要你的确认"}</small>
        </div>
      </div>
      {p.command && (
        <pre>
          {typeof p.command === "string" ? p.command : p.command.join(" ")}
        </pre>
      )}
      <div className="approval-actions">
        <button onClick={() => onResolve(approval.id, "decline")}>拒绝</button>
        <button
          className="approve"
          onClick={() => onResolve(approval.id, "accept")}
        >
          <Check />
          允许一次
        </button>
      </div>
    </article>
  );
}

function ProviderSwitchModal({
  thread,
  providers,
  onClose,
  onCreated,
}: {
  thread: ThreadSummary;
  providers: Provider[];
  onClose: () => void;
  onCreated: (providerId: string, threadId: string) => void;
}) {
  const choices = providers.filter(
    (provider) => provider.id !== thread.providerId,
  );
  const [targetProviderId, setTargetProviderId] = useState(
    choices[0]?.id || "",
  );
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState(
    thread.reasoningEffort || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !targetProviderId) return;
    setBusy(true);
    setError("");
    try {
      const created = await post(
        `/threads/${thread.providerId}/${thread.id}/migrate`,
        {
          targetProviderId,
          model: model || undefined,
          reasoningEffort: reasoningEffort || undefined,
        },
      );
      onCreated(targetProviderId, created.id);
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="切换此 Session 的供应商" onClose={() => !busy && onClose()}>
      <form className="form" onSubmit={submit}>
        <div className="migration-note">
          <ArrowRightLeft />
          <div>
            <b>带完整历史创建供应商切换分支</b>
            <p>
              Codex 会 fork 当前 Session
              的完整历史，并让新分支使用目标供应商；原分支保留，运行中或待审批时不能切换。
            </p>
          </div>
        </div>
        <label>
          目标供应商
          <select
            value={targetProviderId}
            onChange={(e) => setTargetProviderId(e.target.value)}
          >
            {choices.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        {targetProviderId && (
          <ModelPicker
            providerId={targetProviderId}
            model={model}
            reasoningEffort={reasoningEffort}
            onChange={(next) => {
              setModel(next.model);
              setReasoningEffort(next.reasoningEffort);
            }}
          />
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy || !targetProviderId}>
          <ArrowRightLeft />
          {busy ? "正在创建分支…" : "创建切换分支"}
        </button>
      </form>
    </Modal>
  );
}

function itemView(item: any) {
  if (item.type === "userMessage")
    return (
      <div className="message user" key={item.id}>
        {item.content
          ?.filter((x: any) => x.type === "text")
          .map((x: any) => x.text)
          .join("\n")}
      </div>
    );
  if (item.type === "agentMessage")
    return (
      <div className="message agent" key={item.id}>
        {item.text}
      </div>
    );
  if (item.type === "reasoning")
    return (
      <details className="tool-item" key={item.id}>
        <summary>
          <Activity />
          思考过程
        </summary>
        <div>{item.summary?.join("\n") || item.content?.join("\n")}</div>
      </details>
    );
  if (item.type === "commandExecution")
    return (
      <details className="tool-item" key={item.id}>
        <summary>
          <Command />
          {item.status === "inProgress" ? "正在执行" : "已执行"} ·{" "}
          {item.command}
        </summary>
        {item.aggregatedOutput && <pre>{item.aggregatedOutput}</pre>}
      </details>
    );
  if (item.type === "fileChange")
    return (
      <div className="tool-item compact" key={item.id}>
        <Zap /> 修改了 {item.changes?.length || 0} 个文件
      </div>
    );
  return null;
}

function Chat({
  thread,
  provider,
  approvals,
  events,
  onBack,
  onSnapshot,
  onSwitchProvider,
  onSelectThread,
}: {
  thread: ThreadSummary;
  provider?: Provider;
  approvals: Approval[];
  events: any[];
  onBack: () => void;
  onSnapshot: () => void;
  onSwitchProvider: () => void;
  onSelectThread: (providerId: string, threadId: string) => void;
}) {
  const [full, setFull] = useState<any>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      api(`/threads/${thread.providerId}/${thread.id}`)
        .then(setFull)
        .catch((e) => setError(e.message)),
    [thread.id, thread.providerId],
  );
  useEffect(() => {
    load();
  }, [load, events.length]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [full, events]);
  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText("");
    setError("");
    try {
      await post(`/threads/${thread.providerId}/${thread.id}/turns`, {
        text: value,
      });
    } catch (e: any) {
      setText(value);
      setError(e.message);
    } finally {
      setSending(false);
    }
  };
  const resolve = async (id: string, decision: string) => {
    try {
      await post(`/approvals/${encodeURIComponent(id)}`, { decision });
      onSnapshot();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const streamed =
    thread.status === "running"
      ? events
          .filter(
            (e) =>
              e.params?.threadId === thread.id &&
              e.method === "item/agentMessage/delta" &&
              (!thread.activeTurnId ||
                e.params?.turnId === thread.activeTurnId),
          )
          .map((e) => e.params.delta)
          .join("")
      : "";
  const threadApprovals = approvals.filter(
    (a) => a.request.params?.threadId === thread.id,
  );
  const latestTurnError = full?.turns?.at?.(-1)?.error;
  const rawTaskError = thread.lastError || latestTurnError?.message;
  const rawErrorInfo = thread.errorCode || latestTurnError?.codexErrorInfo;
  const taskErrorCode =
    typeof rawErrorInfo === "string"
      ? rawErrorInfo
      : rawErrorInfo && typeof rawErrorInfo === "object"
        ? Object.keys(rawErrorInfo)[0]
        : undefined;
  const taskError = rawTaskError
    ? taskErrorCode === "unauthorized"
      ? `登录状态已失效：${rawTaskError}`
      : rawTaskError
    : "";
  return (
    <main className="chat">
      <header className="chat-header">
        <button className="icon-btn mobile-back" onClick={onBack}>
          <ArrowLeft />
        </button>
        <span
          className="provider-logo small"
          style={{ "--color": provider?.color } as any}
        >
          <Bot />
        </span>
        <div className="chat-title">
          <h2>{thread.name}</h2>
          <p>
            {basename(thread.cwd)} · {provider?.name}
          </p>
        </div>
        <Status status={thread.status} />
        <button
          className="provider-switch"
          onClick={onSwitchProvider}
          disabled={thread.status === "running" || thread.status === "waiting"}
          title="为此 Session 切换供应商"
        >
          <ArrowRightLeft />
          <span>{provider?.name || "未知供应商"}</span>
        </button>
        <div className="thread-actions-wrap">
          <button
            className="icon-btn"
            onClick={() => setActionsOpen((open) => !open)}
          >
            <MoreHorizontal />
          </button>
          {actionsOpen && (
            <div className="thread-actions">
              <button
                onClick={async () => {
                  const name = prompt("新的 Session 名称", thread.name)?.trim();
                  if (!name) return;
                  setActionsOpen(false);
                  try {
                    await api(`/threads/${thread.providerId}/${thread.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ name }),
                    });
                    onSnapshot();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                重命名
              </button>
              <button
                disabled={
                  thread.status === "running" || thread.status === "waiting"
                }
                onClick={async () => {
                  setActionsOpen(false);
                  try {
                    const created = await post(
                      `/threads/${thread.providerId}/${thread.id}/fork`,
                    );
                    onSelectThread(thread.providerId, created.id);
                    onSnapshot();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                复制为分支
              </button>
              <button
                disabled={
                  thread.status === "running" || thread.status === "waiting"
                }
                onClick={async () => {
                  if (!confirm(`归档 ${thread.name}？`)) return;
                  setActionsOpen(false);
                  try {
                    await post(
                      `/threads/${thread.providerId}/${thread.id}/archive`,
                    );
                    onBack();
                    onSnapshot();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                归档 Session
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="timeline">
        <div className="session-meta">
          <Folder />
          {thread.cwd}
          <span>{thread.model}</span>
        </div>
        {full?.turns?.flatMap((turn: any) =>
          (turn.items || []).map((item: any) => {
            if (
              streamed &&
              item.type === "agentMessage" &&
              (turn.id === thread.activeTurnId || turn.status === "inProgress")
            )
              return null;
            return itemView(item);
          }),
        )}
        {streamed && (
          <div className="message agent streaming">
            {streamed}
            <i />
          </div>
        )}
        {threadApprovals.map((a) => (
          <ApprovalCard key={a.id} approval={a} onResolve={resolve} />
        ))}
        {taskError && (
          <div className="task-error" role="alert">
            <ShieldAlert />
            <div>
              <b>Codex 执行失败</b>
              <p>{taskError}</p>
              {taskErrorCode && <small>错误类型：{taskErrorCode}</small>}
            </div>
          </div>
        )}
        {error && <p className="error-banner">{error}</p>}
        <div ref={bottom} />
      </div>
      <footer className="composer">
        <div className="composer-box">
          <textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              thread.status === "running"
                ? "追加指令或等待 Codex…"
                : "向 Codex 发送指令…"
            }
          />
          {thread.status === "running" && thread.activeTurnId ? (
            <button
              className="send stop"
              onClick={() =>
                post(`/threads/${thread.providerId}/${thread.id}/interrupt`, {
                  turnId: thread.activeTurnId,
                })
              }
            >
              <CircleStop />
            </button>
          ) : (
            <button
              className="send"
              onClick={send}
              disabled={!text.trim() || sending}
            >
              <Send />
            </button>
          )}
        </div>
        <small>
          {sending ? "正在提交指令…" : "Enter 发送 · Shift + Enter 换行"}
        </small>
      </footer>
    </main>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(empty);
  const [selected, setSelected] = useState<string>();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [events, setEvents] = useState<any[]>([]);
  const [providerModal, setProviderModal] = useState(false);
  const [threadModal, setThreadModal] = useState<{
    cwd?: string;
    project?: ProjectRecord;
  } | null>(null);
  const [switchThread, setSwitchThread] = useState<ThreadSummary | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "attention"
  >("all");
  const [sidebar, setSidebar] = useState(true);
  const [authError, setAuthError] = useState(false);
  const refresh = useCallback(
    () =>
      getSnapshot()
        .then((s) => {
          setSnapshot(s);
          setAuthError(false);
        })
        .catch((e) => {
          if (e.message.includes("令牌")) setAuthError(true);
        }),
    [],
  );
  useEffect(() => {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    const sharedToken = fragment.get("token");
    if (sharedToken) {
      setToken(sharedToken);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
    refresh();
  }, [refresh]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let timer: number;
    const connect = () => {
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws?token=${encodeURIComponent(getToken())}`,
      );
      ws.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === "snapshot") setSnapshot(message.data);
        else if (message.type === "thread.updated")
          setSnapshot((s) => ({
            ...s,
            threads: [
              message.data,
              ...s.threads.filter(
                (t) =>
                  !(
                    t.id === message.data.id &&
                    t.providerId === message.data.providerId
                  ),
              ),
            ].sort((a, b) => b.updatedAt - a.updatedAt),
          }));
        else if (message.type === "provider.status")
          setSnapshot((s) => ({
            ...s,
            providers: s.providers.map((p) =>
              p.id === message.data.providerId
                ? {
                    ...p,
                    online: message.data.online,
                    error: message.data.error,
                  }
                : p,
            ),
          }));
        else if (message.type === "runtime.status")
          setSnapshot((s) => ({
            ...s,
            runtime: {
              starting: false,
              remoteUrl: "",
              ...s.runtime,
              ...message.data,
            },
          }));
        else if (message.type === "approval.requested")
          setSnapshot((s) => ({
            ...s,
            approvals: [
              ...s.approvals.filter((a) => a.id !== message.data.id),
              message.data,
            ],
          }));
        else if (message.type === "approval.resolved")
          setSnapshot((s) => ({
            ...s,
            approvals: s.approvals.filter(
              (a) => a.id !== message.data.approvalId,
            ),
          }));
        else if (message.type === "codex.event")
          setEvents((v) => [...v.slice(-150), message.data]);
      };
      ws.onclose = () => {
        timer = window.setTimeout(connect, 2500);
      };
    };
    connect();
    return () => clearTimeout(timer);
  }, [authError]);
  const projects = useMemo(() => {
    const groups = mergeProjectGroups(
      snapshot.projects || [],
      snapshot.threads,
    );
    const statusThreads = (threads: ThreadSummary[]) =>
      statusFilter === "active"
        ? threads.filter(
            (thread) =>
              thread.status === "running" || thread.status === "waiting",
          )
        : statusFilter === "attention"
          ? threads.filter(
              (thread) =>
                thread.status === "waiting" || thread.status === "error",
            )
          : threads;
    return filterProjectGroups(
      groups.map((group) => ({
        ...group,
        sessions: statusThreads(group.sessions),
      })),
      query,
    ).filter(
      (group) =>
        group.sessions.length > 0 || (!query && statusFilter === "all"),
    );
  }, [snapshot.projects, snapshot.threads, query, statusFilter]);
  const counts = useMemo(
    () => ({
      running: snapshot.threads.filter((thread) => thread.status === "running")
        .length,
      waiting: snapshot.threads.filter((thread) => thread.status === "waiting")
        .length,
      errors: snapshot.threads.filter((thread) => thread.status === "error")
        .length,
    }),
    [snapshot.threads],
  );
  const sourceErrors = snapshot.providers.filter(
    (provider) => provider.kind === "local-profile" && provider.error,
  );
  const toggleProject = (key: string) =>
    setCollapsedProjects((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const current = snapshot.threads.find(
    (t) => `${t.providerId}:${t.id}` === selected,
  );
  useEffect(() => {
    if (!selected && snapshot.threads.length && window.innerWidth > 760)
      setSelected(
        `${snapshot.threads[0].providerId}:${snapshot.threads[0].id}`,
      );
  }, [snapshot.threads, selected]);
  if (authError)
    return (
      <div className="auth-page">
        <div className="auth-card">
          <span>
            <KeyRound />
          </span>
          <h1>连接 Codex Deck</h1>
          <p>输入服务端设置的 REMOTE_TOKEN。令牌只保存在这个浏览器中。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get(
                "token",
              ) as string;
              setToken(value);
              setAuthError(false);
              refresh();
            }}
          >
            <input
              autoFocus
              required
              name="token"
              type="password"
              placeholder="访问令牌"
            />
            <button className="primary">连接</button>
          </form>
        </div>
      </div>
    );
  return (
    <div className="app-shell">
      <aside
        className={`${sidebar ? "show" : ""} ${current ? "mobile-hidden" : ""}`}
      >
        <div className="brand">
          <span>
            <Sparkles />
          </span>
          <div>
            <b>Codex Deck</b>
            <small>REMOTE WORKSPACE</small>
          </div>
          <button className="icon-btn" onClick={() => setSidebar(false)}>
            <X />
          </button>
        </div>
        <div className="session-overview">
          <div>
            <b>{projects.length}</b>
            <small>项目</small>
          </div>
          <div>
            <b>{snapshot.threads.length}</b>
            <small>会话</small>
          </div>
          <button onClick={() => setThreadModal({})}>
            <Plus />
            新建
          </button>
        </div>
        <div className="watch-strip">
          <button
            className={statusFilter === "active" ? "active" : ""}
            onClick={() =>
              setStatusFilter(statusFilter === "active" ? "all" : "active")
            }
          >
            <span className="watch-dot running" />
            {counts.running} 运行
          </button>
          <button
            className={statusFilter === "attention" ? "active" : ""}
            onClick={() =>
              setStatusFilter(
                statusFilter === "attention" ? "all" : "attention",
              )
            }
          >
            <span className="watch-dot waiting" />
            {counts.waiting} 待处理
            {counts.errors > 0 && <em>{counts.errors} 异常</em>}
          </button>
        </div>
        <div className="session-search">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目、Session、模型…"
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery("")}>
              <X />
            </button>
          )}
        </div>
        <div className="section-label">
          <span>现有 Codex 会话</span>
          <button className="icon-btn" onClick={refresh}>
            <RefreshCw />
          </button>
        </div>
        <div className="thread-list">
          {projects.map((project) => {
            const collapsed = collapsedProjects.has(project.key);
            return (
              <div className="project-group" key={project.key}>
                <div className="project-heading">
                  <button
                    className="project-toggle"
                    onClick={() => toggleProject(project.key)}
                  >
                    <Folder />
                    <span title={project.cwd}>{basename(project.cwd)}</span>
                    {collapsed ? <ChevronRight /> : <ChevronDown />}
                  </button>
                  <b>{project.sessions.length}</b>
                  <button
                    className="project-add"
                    title={`在 ${basename(project.cwd)} 中新建会话`}
                    aria-label={`在 ${basename(project.cwd)} 中新建会话`}
                    onClick={() =>
                      setThreadModal({
                        cwd: project.cwd,
                        project: snapshot.projects?.find(
                          (item) => item.key === project.key,
                        ),
                      })
                    }
                  >
                    <Plus />
                  </button>
                </div>
                {!collapsed &&
                  project.sessions.map((t) => {
                    const sessionKey = `${t.providerId}:${t.id}`;
                    return (
                      <button
                        key={sessionKey}
                        className={selected === sessionKey ? "selected" : ""}
                        onClick={() => {
                          setSelected(sessionKey);
                          setSidebar(false);
                        }}
                      >
                        <div className="thread-line">
                          <Status status={t.status} />
                          <time>{fmtTime(t.updatedAt)}</time>
                        </div>
                        <strong>{t.name}</strong>
                        <p>{t.preview}</p>
                        <div className="thread-meta">
                          <span
                            className="provider-badge"
                            style={
                              {
                                "--provider": snapshot.providers.find(
                                  (provider) => provider.id === t.providerId,
                                )?.color,
                              } as any
                            }
                          >
                            {snapshot.providers.find(
                              (provider) => provider.id === t.providerId,
                            )?.name || "原配置 / 外部"}
                          </span>
                          <small>{t.model}</small>
                          <small>
                            {t.controlMode === "managed" ? "受管" : "历史"}
                          </small>
                        </div>
                        {snapshot.approvals.some(
                          (a) =>
                            a.providerId === t.providerId &&
                            a.request.params?.threadId === t.id,
                        ) && <em>1</em>}
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {!projects.length && (
            <div className="empty-list">
              {query || statusFilter !== "all" ? <Search /> : <Bot />}
              <p>
                {query || statusFilter !== "all"
                  ? "没有匹配的 Session"
                  : "未找到现有会话"}
              </p>
              <small>
                {query || statusFilter !== "all"
                  ? "清除搜索或状态筛选后重试"
                  : "点击刷新或创建一个新的 Codex 会话"}
              </small>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setProviderModal(true)}>
            <Settings />
            供应商设置
            <ChevronRight />
          </button>
        </div>
      </aside>
      <section className="workspace">
        {!sidebar && (
          <button className="floating-menu" onClick={() => setSidebar(true)}>
            <Menu />
          </button>
        )}
        <button className="new-thread" onClick={() => setThreadModal({})}>
          <MessageSquarePlus />
          新会话
        </button>
        {current ? (
          <Chat
            thread={current}
            provider={snapshot.providers.find(
              (p) => p.id === current.providerId,
            )}
            approvals={snapshot.approvals}
            events={events}
            onBack={() => setSelected(undefined)}
            onSnapshot={refresh}
            onSwitchProvider={() => setSwitchThread(current)}
            onSelectThread={(providerId, threadId) =>
              setSelected(`${providerId}:${threadId}`)
            }
          />
        ) : (
          <div className="welcome">
            <span>
              <Bot />
            </span>
            <h1>你的 Codex，随身在线</h1>
            <p>选择一个项目下的现有会话继续工作，或启动新的并行任务。</p>
            <button className="primary" onClick={() => setThreadModal({})}>
              <Plus />
              启动新会话
            </button>
            <div className="system-pills">
              <span>{projects.length} 个项目</span>
              <span>
                {snapshot.threads.filter((t) => t.status === "running").length}{" "}
                个任务运行中
              </span>
            </div>
          </div>
        )}
      </section>
      {providerModal && (
        <ProviderModal
          providers={snapshot.providers}
          runtime={snapshot.runtime}
          defaultCwd={current?.cwd}
          onClose={() => setProviderModal(false)}
          onSaved={setSnapshot}
        />
      )}
      {threadModal && (
        <NewThreadModal
          providers={snapshot.providers}
          initialCwd={threadModal.cwd}
          project={threadModal.project}
          preferences={snapshot.preferences}
          onClose={() => setThreadModal(null)}
          onCreated={(p, id) => {
            setSelected(`${p}:${id}`);
            setTimeout(refresh, 400);
          }}
        />
      )}
      {switchThread && (
        <ProviderSwitchModal
          thread={switchThread}
          providers={snapshot.providers}
          onClose={() => setSwitchThread(null)}
          onCreated={(providerId, threadId) => {
            setSelected(`${providerId}:${threadId}`);
            setTimeout(refresh, 300);
          }}
        />
      )}
    </div>
  );
}
