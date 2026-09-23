import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Folder,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  Search,
  SendHorizontal,
  X,
} from "lucide-react";
import deckLogo from "./assets/logo.svg";
import { Status, ToastStack } from "./ui";
import "./styles.css";
import "./project-groups.css";
import "./sidebar.css";
import "./chat.css";
import "./approval-inbox.css";
import "./overlays.css";
import "./tokens.css";
import "./polish.css";
import "./appearance.css";
import "./task-tools.css";
import "./deck-ui.css";
import "./search-picker.css";
import "./tiled.css";

document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.motion = "off";
document.documentElement.style.colorScheme = "dark";

type DemoStatus = "running" | "waiting" | "error" | "idle";

interface DemoLine {
  role: "user" | "assistant" | "tool";
  text: string;
}

interface DemoSession {
  id: string;
  project: string;
  cwd: string;
  name: string;
  agent: "codex" | "claude" | "opencode";
  status: DemoStatus;
  unseen?: boolean;
  approval?: { summary: string };
  previews: string[];
  lines: DemoLine[];
}

const MOCK_SESSIONS: DemoSession[] = [
  {
    id: "tiled",
    project: "codex-deck",
    cwd: "~/Codecks",
    name: "tiled-mode",
    agent: "codex",
    status: "running",
    previews: [
      "正在生成平铺布局组件…",
      "tsc --noEmit · 类型检查通过",
      "调整 hero 卡片的网格跨度…",
    ],
    lines: [
      { role: "user", text: "给网页加一个平铺模式，活跃会话放在屏幕中间" },
      {
        role: "assistant",
        text: "先看下现有布局：左侧边栏列出全部项目，右侧工作区显示选中的会话。",
      },
      { role: "tool", text: "read src/App.tsx · 1,632 行" },
      {
        role: "assistant",
        text: "原型方案：中心大 tile 显示聚焦会话，周围卫星 tile 是其余活跃会话，空闲项目收进底部 dock。",
      },
      { role: "tool", text: "write src/tiled.css" },
      { role: "assistant", text: "列表模式原样保留，顶栏可以一键切换。" },
    ],
  },
  {
    id: "etl",
    project: "data-pipeline",
    cwd: "~/work/data-pipeline",
    name: "nightly-etl",
    agent: "opencode",
    status: "running",
    previews: [
      "scanning 1,204 files…",
      "writing partitioned output 2026-09-21/",
      "merge 阶段 3/5",
    ],
    lines: [
      { role: "user", text: "把昨晚的增量数据跑一遍" },
      { role: "assistant", text: "开始执行 nightly-etl，先做 schema 校验。" },
      { role: "tool", text: "spark-submit etl.py --date 2026-09-20" },
    ],
  },
  {
    id: "gateway",
    project: "api-gateway",
    cwd: "~/work/api-gateway",
    name: "retry-backoff",
    agent: "claude",
    status: "waiting",
    unseen: true,
    approval: { summary: "rm -rf tmp/certs && ./regen-certs.sh" },
    previews: ["等待审批 · 证书重生成"],
    lines: [
      { role: "user", text: "本地 dev 证书过期了，帮我重建" },
      { role: "assistant", text: "需要删除 tmp/certs 并重新生成，等你确认。" },
    ],
  },
  {
    id: "mobile",
    project: "mobile-app",
    cwd: "~/work/mobile-app",
    name: "push-notify",
    agent: "codex",
    status: "error",
    previews: ["构建失败：签名证书过期"],
    lines: [
      { role: "tool", text: "xcodebuild -scheme PushNotify" },
      {
        role: "assistant",
        text: "失败：PROVISIONING_PROFILE expired，需要先到开发者后台续期。",
      },
    ],
  },
  {
    id: "docs",
    project: "docs-site",
    cwd: "~/work/docs-site",
    name: "i18n-zh",
    agent: "claude",
    status: "idle",
    previews: ["上次活动 2 小时前"],
    lines: [{ role: "assistant", text: "中文翻译已同步到 87%。" }],
  },
  {
    id: "infra",
    project: "infra",
    cwd: "~/work/infra",
    name: "terraform-plan",
    agent: "opencode",
    status: "idle",
    unseen: true,
    previews: ["plan 完成：+3 ~1 -0"],
    lines: [{ role: "assistant", text: "plan 输出已整理成表格。" }],
  },
  {
    id: "dotfiles",
    project: "dotfiles",
    cwd: "~/dotfiles",
    name: "nvim-config",
    agent: "codex",
    status: "idle",
    previews: ["空闲"],
    lines: [{ role: "assistant", text: "lazy.nvim 插件已锁定版本。" }],
  },
];

const dotClass = (status: DemoStatus) =>
  status === "running"
    ? "running"
    : status === "waiting"
      ? "waiting"
      : status === "error"
        ? "error"
        : "idle";

const roleLabel = (role: DemoLine["role"]) =>
  role === "user" ? "你" : role === "tool" ? "工具" : "AI";

function Harness() {
  const [mode, setMode] = useState<"list" | "tiled">("tiled");
  const [sessions, setSessions] = useState<DemoSession[]>(MOCK_SESSIONS);
  const [focusId, setFocusId] = useState("tiled");
  const [listSelected, setListSelected] = useState<string>();
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [tick, setTick] = useState(0);
  const heroBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((v) => v + 1), 2200);
    return () => window.clearInterval(timer);
  }, []);

  const pushToast = (message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2200,
    );
  };

  // 舞台 = 聚焦会话 + 所有活跃会话；空闲会话收进底部 dock。
  const stage = sessions.filter(
    (session) => session.id === focusId || session.status !== "idle",
  );
  const focused = sessions.find((session) => session.id === focusId) || stage[0];
  const satellites = stage.filter((session) => session.id !== focused?.id);
  const dock = sessions.filter(
    (session) => session.status === "idle" && session.id !== focused?.id,
  );
  const railLeft = satellites.filter((_, index) => index % 2 === 0);
  const railRight = satellites.filter((_, index) => index % 2 === 1);

  const projects = useMemo(() => {
    const map = new Map<string, DemoSession[]>();
    for (const session of sessions) {
      const list = map.get(session.project) || [];
      list.push(session);
      map.set(session.project, list);
    }
    return [...map];
  }, [sessions]);

  const previewFor = (session: DemoSession) =>
    session.status === "running"
      ? session.previews[tick % session.previews.length]
      : session.previews[0];

  const resolveApproval = (id: string, ok: boolean) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === id
          ? {
              ...session,
              approval: undefined,
              status: ok ? "running" : "idle",
            }
          : session,
      ),
    );
    pushToast(ok ? "已批准（模拟）" : "已拒绝（模拟）");
  };

  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !focused) return;
    setDraft("");
    const append = (line: DemoLine) =>
      setSessions((current) =>
        current.map((session) =>
          session.id === focused.id
            ? { ...session, lines: [...session.lines, line] }
            : session,
        ),
      );
    append({ role: "user", text });
    window.setTimeout(
      () =>
        append({ role: "assistant", text: "收到，继续处理中…（原型自动回复）" }),
      700,
    );
  };

  useEffect(() => {
    const node = heroBodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [focused?.id, focused?.lines.length]);

  const listSel = sessions.find((session) => session.id === listSelected);

  return (
    <div className="tiled-shell">
      <header className="tiled-topbar">
        <div className="brand">
          <img className="brand-logo" src={deckLogo} alt="" />
          <div>
            <b>Codex Deck</b>
          </div>
          <em className="demo-badge">原型</em>
        </div>
        <div className="library-segment mode-switch" role="tablist">
          <button
            type="button"
            role="tab"
            className={mode === "list" ? "on" : ""}
            aria-selected={mode === "list"}
            onClick={() => setMode("list")}
          >
            <List />
            列表
          </button>
          <button
            type="button"
            role="tab"
            className={mode === "tiled" ? "on" : ""}
            aria-selected={mode === "tiled"}
            onClick={() => setMode("tiled")}
          >
            <LayoutGrid />
            平铺
          </button>
        </div>
        <div className="session-search tiled-search">
          <Search />
          <input placeholder="搜索项目、会话与内容" aria-label="搜索" />
        </div>
        <button
          type="button"
          className="new-session-btn"
          onClick={() => pushToast("原型演示：新建入口不变")}
        >
          <Plus />
          新建
        </button>
      </header>

      {mode === "tiled" ? (
        <div className="tiled-main">
          <main className="tiled-stage">
            <div className="tiled-rail left">
              {railLeft.map((session) => (
                <TileCard
                  key={session.id}
                  session={session}
                  preview={previewFor(session)}
                  onPromote={() => setFocusId(session.id)}
                  onResolve={resolveApproval}
                />
              ))}
            </div>
            {focused && (
              <section
                className={`tile-hero status-${focused.status}`}
                key={focused.id}
              >
                <header className="tile-hero-head">
                  <div className="tile-hero-title">
                    <span className={`watch-dot ${dotClass(focused.status)}`} />
                    <div>
                      <b>{focused.name}</b>
                      <small>
                        <Folder />
                        {focused.project} · {focused.cwd}
                      </small>
                    </div>
                  </div>
                  <div className="tile-hero-side">
                    <span className="agent-tag">{focused.agent}</span>
                    <Status
                      status={focused.status}
                      unseen={focused.unseen}
                      compact
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="打开完整会话"
                      onClick={() =>
                        pushToast("原型演示：点击后进入完整会话页")
                      }
                    >
                      <ChevronRight />
                    </button>
                  </div>
                </header>
                {focused.approval && (
                  <div className="tile-approval">
                    <CircleAlert />
                    <span>
                      等待确认：<code>{focused.approval.summary}</code>
                    </span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="tile-mini-btn ok"
                      onClick={() => resolveApproval(focused.id, true)}
                    >
                      <Check />
                      批准
                    </button>
                    <button
                      type="button"
                      className="tile-mini-btn"
                      onClick={() => resolveApproval(focused.id, false)}
                    >
                      <X />
                      拒绝
                    </button>
                  </div>
                )}
                <div className="tile-hero-body" ref={heroBodyRef}>
                  {focused.lines.map((line, index) => (
                    <div className={`tl-line ${line.role}`} key={index}>
                      <span className="tl-role">{roleLabel(line.role)}</span>
                      <p>{line.text}</p>
                    </div>
                  ))}
                  {focused.status === "running" && (
                    <div className="tl-line tool tl-live">
                      <LoaderCircle className="spin" />
                      <p>{previewFor(focused)}</p>
                    </div>
                  )}
                </div>
                <form className="tile-composer" onSubmit={send}>
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={`给 ${focused.name} 发消息…`}
                    aria-label="给聚焦会话发消息"
                  />
                  <button type="submit" className="primary">
                    <SendHorizontal />
                    发送
                  </button>
                </form>
              </section>
            )}
            <div className="tiled-rail right">
              {railRight.map((session) => (
                <TileCard
                  key={session.id}
                  session={session}
                  preview={previewFor(session)}
                  onPromote={() => setFocusId(session.id)}
                  onResolve={resolveApproval}
                />
              ))}
            </div>
          </main>
          <footer className="tiled-dock">
            <span className="tiled-dock-label">
              <Bot />
              待命
            </span>
            {dock.map((session) => (
              <button
                type="button"
                className="dock-chip"
                key={session.id}
                onClick={() => {
                  setFocusId(session.id);
                  pushToast(`已把 ${session.name} 提到舞台中央`);
                }}
              >
                <span className={`watch-dot ${session.unseen ? "unseen" : "idle"}`} />
                {session.name}
                <small>{session.project}</small>
              </button>
            ))}
            {!dock.length && (
              <span className="tiled-dock-empty">所有会话都在舞台上</span>
            )}
          </footer>
        </div>
      ) : (
        <div className="demo-list">
          <aside className="sidebar show">
            <div className="sidebar-toolbar">
              <div className="session-search">
                <Search />
                <input placeholder="搜索项目、会话与内容" />
              </div>
            </div>
            <div className="sidebar-meta">
              <span>
                {projects.length} 项目 · {sessions.length} 会话
              </span>
            </div>
            <div className="thread-list">
              {projects.map(([name, list]) => (
                <div className="demo-group" key={name}>
                  <div className="demo-group-head">
                    <Folder />
                    {name}
                  </div>
                  {list.map((session) => (
                    <button
                      type="button"
                      className={`demo-row ${listSelected === session.id ? "on" : ""}`}
                      key={session.id}
                      onClick={() => setListSelected(session.id)}
                    >
                      <span
                        className={`watch-dot ${session.unseen ? "unseen" : dotClass(session.status)}`}
                      />
                      <span className="demo-row-name">{session.name}</span>
                      <em>{session.agent}</em>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>
          <section className="workspace demo-list-workspace">
            {listSel ? (
              <div className="demo-list-chat">
                <header className="demo-list-chat-head">
                  <div className="tile-hero-title">
                    <span
                      className={`watch-dot ${dotClass(listSel.status)}`}
                    />
                    <div>
                      <b>{listSel.name}</b>
                      <small>
                        <Folder />
                        {listSel.project} · {listSel.cwd}
                      </small>
                    </div>
                  </div>
                  <Status status={listSel.status} compact />
                </header>
                <div className="demo-list-lines">
                  {listSel.lines.map((line, index) => (
                    <div className={`tl-line ${line.role}`} key={index}>
                      <span className="tl-role">{roleLabel(line.role)}</span>
                      <p>{line.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="demo-list-welcome">
                <h1>开始工作</h1>
                <p>列表模式：和现在一样，项目都列在左边，点选后在右侧打开。</p>
              </div>
            )}
          </section>
        </div>
      )}
      <ToastStack toasts={toasts} />
    </div>
  );
}

function TileCard({
  session,
  preview,
  onPromote,
  onResolve,
}: {
  session: DemoSession;
  preview: string;
  onPromote: () => void;
  onResolve: (id: string, ok: boolean) => void;
}) {
  return (
    <div
      className={`tile-card status-${session.status}`}
      role="button"
      tabIndex={0}
      onClick={onPromote}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPromote();
        }
      }}
    >
      <div className="tile-card-head">
        <span
          className={`watch-dot ${session.unseen ? "unseen" : dotClass(session.status)}`}
        />
        <b>{session.name}</b>
        {session.unseen && <em className="tile-unseen">新回复</em>}
      </div>
      <small className="tile-card-project">
        <Folder />
        {session.project} · {session.cwd}
      </small>
      <p className="tile-card-preview">
        {session.status === "running" && <LoaderCircle className="spin" />}
        {preview}
      </p>
      {session.approval && (
        <div
          className="tile-card-approval"
          onClick={(event) => event.stopPropagation()}
        >
          <CircleAlert />
          <span className="grow">需要确认</span>
          <button
            type="button"
            className="tile-mini-btn ok"
            onClick={() => onResolve(session.id, true)}
          >
            批准
          </button>
          <button
            type="button"
            className="tile-mini-btn"
            onClick={() => onResolve(session.id, false)}
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
