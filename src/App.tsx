import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Command,
  Folder,
  KeyRound,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RefreshCw,
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
import type { Approval, Provider, Snapshot, ThreadSummary } from "./types";
import { groupThreadsByProject } from "./projects";

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
  onClose,
  onSaved,
}: {
  providers: Provider[];
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
            <b>已连接 CC Switch</b>
            <small>
              每 5 秒同步 Codex 供应商，并隔离每个供应商的运行空间。
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
                  ? `CC Switch · ${p.baseUrl || "官方登录"}`
                  : p.kind === "custom"
                    ? `${p.baseUrl} · 独立空间`
                    : "使用当前 Codex 配置"}
              </small>
            </div>
            <span className={p.online ? "online" : "offline-dot"}>
              {p.online ? "在线" : "离线"}
            </span>
            {p.kind === "custom" && (
              <button
                className="icon-btn danger"
                title="删除"
                onClick={async () => {
                  if (confirm(`删除 ${p.name}？会保留其会话目录。`))
                    onSaved(await remove(`/providers/${p.id}`));
                }}
              >
                <Trash2 />
              </button>
            )}
          </div>
        ))}
      </div>
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
  onClose,
  onCreated,
}: {
  providers: Provider[];
  initialCwd?: string;
  onClose: () => void;
  onCreated: (p: string, id: string) => void;
}) {
  const online = providers.filter((p) => p.online);
  const [form, setForm] = useState({
    providerId: online[0]?.id || providers[0]?.id || "",
    cwd: initialCwd,
    name: "",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
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
                {p.online ? "" : "（离线）"}
              </option>
            ))}
          </select>
        </label>
        <label>
          工作目录
          <input
            required
            readOnly={Boolean(initialCwd)}
            className={initialCwd ? "readonly" : ""}
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            placeholder={
              navigator.userAgent.includes("Windows")
                ? "D:\\Code\\project 或 /mnt/d/Code/project"
                : "/home/me/project"
            }
          />
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
              onChange={(e) => setForm({ ...form, sandbox: e.target.value })}
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
                setForm({ ...form, approvalPolicy: e.target.value })
              }
            >
              <option value="on-request">按需询问</option>
              <option value="untrusted">严格询问</option>
              <option value="never">不询问</option>
            </select>
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={submitting}>
          <Sparkles />
          {submitting ? "正在创建…" : "创建会话"}
        </button>
      </form>
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
}: {
  thread: ThreadSummary;
  provider?: Provider;
  approvals: Approval[];
  events: any[];
  onBack: () => void;
  onSnapshot: () => void;
}) {
  const [full, setFull] = useState<any>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
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
    if (!value) return;
    setText("");
    setError("");
    try {
      await post(`/threads/${thread.providerId}/${thread.id}/turns`, {
        text: value,
      });
    } catch (e: any) {
      setText(value);
      setError(e.message);
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
  const streamed = events
    .filter(
      (e) =>
        e.providerId === thread.providerId &&
        e.params?.threadId === thread.id &&
        e.method === "item/agentMessage/delta",
    )
    .map((e) => e.params.delta)
    .join("");
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
        <button className="icon-btn">
          <MoreHorizontal />
        </button>
      </header>
      <div className="timeline">
        <div className="session-meta">
          <Folder />
          {thread.cwd}
          <span>{thread.model}</span>
        </div>
        {full?.turns?.flatMap((turn: any) => turn.items?.map(itemView))}
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
            <button className="send" onClick={send} disabled={!text.trim()}>
              <Send />
            </button>
          )}
        </div>
        <small>Enter 发送 · Shift + Enter 换行</small>
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
  const [threadModal, setThreadModal] = useState<{ cwd?: string } | null>(null);
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
  const projects = useMemo(
    () => groupThreadsByProject(snapshot.threads),
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
                    onClick={() => setThreadModal({ cwd: project.cwd })}
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
                        <small>{t.model}</small>
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
          {!snapshot.threads.length && (
            <div className="empty-list">
              <Bot />
              <p>未找到现有会话</p>
              <small>点击刷新或创建一个新的 Codex 会话</small>
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
          onClose={() => setProviderModal(false)}
          onSaved={setSnapshot}
        />
      )}
      {threadModal && (
        <NewThreadModal
          providers={snapshot.providers}
          initialCwd={threadModal.cwd}
          onClose={() => setThreadModal(null)}
          onCreated={(p, id) => {
            setSelected(`${p}:${id}`);
            setTimeout(refresh, 400);
          }}
        />
      )}
    </div>
  );
}
