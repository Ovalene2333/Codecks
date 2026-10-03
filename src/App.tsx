import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  BellRing,
  FileText,
  Folder,
  FolderPlus,
  Gauge,
  GitBranch,
  KeyRound,
  SunMoon,
  Terminal,
  Zap,
} from "lucide-react";
import {
  api,
  getHealth,
  getSnapshot,
  getToken,
  pairWithCode,
  post,
  put,
  remove,
  setToken,
} from "./api";
import { useAppearance } from "./appearance";
import { copyText } from "./clipboard";
import type {
  AgentId,
  ProjectRecord,
  RuntimeSnapshot,
  SessionWakeState,
  Snapshot,
  ApprovalResolveBody,
  SessionSearchMatch,
  SessionSearchResponse,
  ThreadSummary,
} from "./types";
import {
  filterProjectGroups,
  mergeProjectGroups,
  normalizeProjectPath,
  quickNewProjects,
  threadsForProject,
  type ProjectGroup,
} from "./projects";
import { sessionKey } from "./format";
import {
  cachedThreadKeys,
  dedupeThreadLoad,
  hasSidebarData,
  isThreadUncacheable,
  mergeStaleSnapshot,
  readSnapshotCache,
  readThreadCache,
  readUiCache,
  reconcileSnapshot,
  writeSnapshotCache,
  writeThreadCache,
  writeUiCache,
} from "./cache";
import {
  ActionSheet,
  ConfirmDialog,
  RenderErrorBoundary,
  ToastStack,
} from "./ui";
import { Sidebar } from "./layout/Sidebar";
import { MobileTabBar, useMobileLayout } from "./layout/MobileNav";
import { MonitorPanel } from "./monitor/MonitorPanel";
import {
  activityKey,
  applyActivityUpdate,
  resetActivities,
} from "./monitor/activity-store";
import { ChatWorkspace } from "./session/ChatWorkspace";
import { Welcome } from "./welcome/Welcome";
import { NewThreadModal } from "./overlays/NewThreadModal";
import { SettingsModal, type SettingsTab } from "./settings/SettingsModal";
import { ProviderSwitchModal } from "./overlays/ProviderSwitchModal";
import { RenameModal } from "./overlays/RenameModal";
import { WakeModal } from "./overlays/WakeModal";
import { ProjectDefaultsModal } from "./overlays/ProjectDefaultsModal";
import { UsageDrawer, type UsageView } from "./usage/UsageChip";
import { SessionToolbar } from "./layout/SessionToolbar";
import { Modal } from "./ui";
import { appendCodexEvent } from "./session/streaming";
import {
  agentName,
  approvalPath,
  capabilitiesFor,
  providerForThread,
  threadArchivePath,
  threadPath,
  threadRemovePath,
} from "./agents";
import { ApprovalInbox } from "./overlays/ApprovalInbox";
import { TaskCenter } from "./tasks/TaskCenter";
import { ToolCenter } from "./tools/ToolCenter";
import { toolPath } from "../plugin/client-registry";
import {
  canonicalDeckPath,
  deckDepth,
  deckEntry,
  deckRewrite,
  readDeckState,
  routeForPath,
  sessionKeyFromPath,
  sessionPath,
  SESSIONS_PATH,
} from "./deck-history";
import {
  completedThreads,
  readUnseenSessions,
  reconcileUnseenSessions,
  sameSessionSet,
  threadStatusMap,
  writeUnseenSessions,
} from "./session/activity";
import { approvalPreview, threadForApproval } from "./session/approvals";
import { fetchThreadFull } from "./session/thread-load";
import {
  requestSystemNotifications,
  sendSystemNotification,
  systemNotificationPermission,
} from "./notifications";
import { useDeckShortcuts } from "./shortcuts";
import { getDeckSettings, useDeckSettings } from "./deck-settings";

const empty: Snapshot = { providers: [], threads: [], approvals: [] };
const isToolPath = (pathname: string) => Boolean(toolPath(pathname));
const readDeckHistoryState = () => readDeckState(window.history.state);

export function App() {
  const appearance = useAppearance();
  const { hiddenTools } = useDeckSettings();
  const [snapshot, setSnapshot] = useState(() => {
    const cached = readSnapshotCache();
    // 首页“运行中”的步骤、“新回复”的预览靠活动数据：用缓存先画出来，
    // 实时快照到了再整体替换，避免这两块刷新后先空着再跳出来。
    if (cached?.activities) resetActivities(cached.activities);
    return cached || empty;
  });
  const [loading, setLoading] = useState(
    () => !hasSidebarData(readSnapshotCache()),
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : sessionKeyFromPath(window.location.pathname),
  );
  const [library, setLibrary] = useState<"active" | "archived">("active");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(readUiCache().expandedProjects),
  );
  const [events, setEvents] = useState<any[]>([]);
  // false = 关闭；对象 = 打开，可指定落在哪个标签（监控台的「管理」直达 Agent 页）。
  const [settingsModal, setSettingsModal] = useState<
    false | { tab?: SettingsTab }
  >(false);
  const [threadModal, setThreadModal] = useState<{
    cwd?: string;
    project?: ProjectRecord;
  } | null>(null);
  const [switchThread, setSwitchThread] = useState<ThreadSummary | null>(null);
  const [query, setQuery] = useState("");
  const [contentSearch, setContentSearch] = useState<SessionSearchResponse>();
  const [contentSearchPending, setContentSearchPending] = useState(false);
  const [searchTarget, setSearchTarget] = useState<{
    session: string;
    turnId?: string;
    itemId?: string;
    query: string;
    request: number;
  }>();
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "attention" | "unseen"
  >("all");
  const [unseenSessions, setUnseenSessions] = useState(readUnseenSessions);
  const [notificationPermission, setNotificationPermission] = useState(
    systemNotificationPermission,
  );
  // 当前停在 /sessions：移动端会话列表是底栏「会话」页（整屏侧栏），
  // 桌面端侧栏常驻，此时工作区照常显示总览。
  const [sessionsView, setSessionsView] = useState(
    () => routeForPath(location.pathname, isToolPath).view === "sessions",
  );
  const mobile = useMobileLayout();
  // 移动端底栏的两个就地面板：工具列表、新建时的项目快选。
  const [mobileSheet, setMobileSheet] = useState<"tools" | "new" | null>(null);
  const [authError, setAuthError] = useState(false);
  const [pairingAvailable, setPairingAvailable] = useState(false);
  const [pairMessage, setPairMessage] = useState("");
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: React.ReactNode;
    confirmLabel?: string;
    danger?: boolean;
    run: () => Promise<void> | void;
  } | null>(null);
  const [rename, setRename] = useState<
    | { kind: "thread"; thread: ThreadSummary }
    | { kind: "project"; project: ProjectGroup }
    | null
  >(null);
  const [usageOpen, setUsageOpen] = useState<UsageView | null>(null);
  const [projectEdit, setProjectEdit] = useState<ProjectRecord | null>(null);
  const [historyHelp, setHistoryHelp] = useState<ThreadSummary | null>(null);
  const [sheet, setSheet] = useState<ThreadSummary | null>(null);
  const [wakeThread, setWakeThread] = useState<ThreadSummary | null>(null);
  const [phoneSettings, setPhoneSettings] = useState(false);
    const [taskScope, setTaskScope] = useState<string | null>();
  const [page, setPage] = useState(() =>
    isToolPath(location.pathname) ? "tools" : "workspace",
  );
  const openThreadModalFromSidebar = (next: {
    cwd?: string;
    project?: ProjectRecord;
  }) => {
    setThreadModal(next);
  };
  const previousThreadStatuses = useRef(threadStatusMap(snapshot.threads));
  const notifiedApprovals = useRef(new Set<string>());
  // 会话选中时间点：新建会话到其进 snapshot 之间有窗口期，失效守卫据此宽限
  const selectedAtRef = useRef(0);

  const pushToast = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2000,
    );
  }, []);

  useEffect(() => {
    // URL 归一化：老别名、非本应用条目、旧版缺 depth 的条目都重写一遍
    // toolPath 返回别名归一化后的规范路径（/page/terminal→/terminal、
    // /text-files→/text-editor）；/monitor 并入首页后归一化为 /。
    const canonicalPath =
      toolPath(location.pathname) || canonicalDeckPath(location.pathname);
    const initial = readDeckHistoryState();
    if (
      canonicalPath !== location.pathname ||
      !initial?.__codexDeck ||
      initial.depth === undefined
    ) {
      window.history.replaceState(
        deckRewrite(initial, routeForPath(canonicalPath, isToolPath)),
        "",
        canonicalPath,
      );
    }
    const syncRoute = () => {
      const apply = () => {
        const route = routeForPath(location.pathname, isToolPath);
        setPage(route.page);
        setSelected(route.session);
        setSessionsView(route.view === "sessions");
      };
      apply();
    };
    window.addEventListener("popstate", syncRoute);
    syncRoute();
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  // 应用内“返回”：栈里还有本应用的上一级页面就真正回退；
  // 直接进入/刷新出来的单级条目则原地改写回工作区，避免退出循环。
  const leaveToWorkspace = useCallback(() => {
    const state = readDeckHistoryState();
    if (state && deckDepth(state) > 1) {
      window.history.back();
      return;
    }
    window.history.replaceState(
      deckRewrite(state, routeForPath("/", isToolPath)),
      "",
      "/",
    );
    setSelected(undefined);
    setSessionsView(false);
    setPage("workspace");
  }, []);

  // 「总览」入口：首页是一级页面，从会话过去 = 压入 / 条目；
  // 从 /sessions 回来走返回语义（它由首页压入），不在两个一级页之间来回堆栈。
  const goHome = useCallback(() => {
    if (location.pathname === SESSIONS_PATH) {
      leaveToWorkspace();
      return;
    }
    setSessionsView(false);
    if (location.pathname === "/") return;
    window.history.pushState(
      deckEntry(readDeckHistoryState(), routeForPath("/", isToolPath)),
      "",
      "/",
    );
    setSelected(undefined);
  }, [leaveToWorkspace]);

  // 移动端「会话」页：压入 /sessions，系统返回回到总览。
  const openSessions = useCallback(() => {
    if (location.pathname === SESSIONS_PATH) return;
    window.history.pushState(
      deckEntry(readDeckHistoryState(), {
        page: "workspace",
        view: "sessions",
      }),
      "",
      SESSIONS_PATH,
    );
    setSelected(undefined);
    setSessionsView(true);
  }, []);

  useDeckShortcuts({ goHome });

  const markSessionSeen = useCallback((key: string) => {
    setUnseenSessions((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      writeUnseenSessions(next);
      return next;
    });
  }, []);

  const markAllSeen = useCallback(() => {
    setUnseenSessions((current) => {
      if (!current.size) return current;
      const next = new Set<string>();
      writeUnseenSessions(next);
      return next;
    });
  }, []);

  // 快照竞态守卫：并发的 GET /snapshot 可能乱序返回；且请求在途时落地的
  // WS 事件比响应更新。seq 丢弃被取代的旧请求，wsClock 区分“干净响应”
  // （整体 reconcile）与“中途有 WS 事件”（保守合并，见 mergeStaleSnapshot）。
  const refreshSeqRef = useRef(0);
  const wsClockRef = useRef(0);

  // 打开会话 = 压入 /session/<key> 条目；已在该会话页时只同步视图
  const openSessionKey = useCallback(
    (key: string) => {
      markSessionSeen(key);
      selectedAtRef.current = Date.now();
      setSelected(key);
      setSessionsView(false);
      if (sessionKeyFromPath(location.pathname) !== key)
        window.history.pushState(
          deckEntry(readDeckHistoryState(), {
            page: "workspace",
            view: "session",
            session: key,
          }),
          "",
          sessionPath(key),
        );
    },
    [markSessionSeen],
  );

  const openSession = useCallback(
    (thread: ThreadSummary) => {
      openSessionKey(sessionKey(thread));
      setLibrary(thread.archived ? "archived" : "active");
    },
    [openSessionKey],
  );

  const refreshOfficialUsage = useCallback(
    async (force = false) => {
      try {
        const runtime = await post<RuntimeSnapshot>(
          `/runtime/rate-limits${force ? "?force=1" : ""}`,
        );
        setSnapshot((current) => ({ ...current, runtime }));
      } catch (error: any) {
        pushToast(error?.message || "Official 额度刷新失败");
      }
    },
    [pushToast],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    const seq = ++refreshSeqRef.current;
    const startClock = wsClockRef.current;
    return getSnapshot()
      .then((next) => {
        // 已有更新的刷新在途：旧响应直接丢弃，避免回退新状态。
        if (seq !== refreshSeqRef.current) return;
        // 期间收到过 WS 消息时，响应里的活动可能比已推送的旧，交给 WS 为准。
        if (wsClockRef.current === startClock && next.activities)
          resetActivities(next.activities);
        setSnapshot((current) => {
          const reconciled =
            wsClockRef.current === startClock
              ? reconcileSnapshot(current, next)
              : mergeStaleSnapshot(current, next);
          writeSnapshotCache(reconciled);
          return reconciled;
        });
        setAuthError(false);
      })
      .catch((error) => {
        if (error.message.includes("令牌")) setAuthError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!authError) return;
    let cancelled = false;
    setPairMessage("");
    getHealth()
      .then((health) => {
        if (!cancelled) setPairingAvailable(Boolean(health?.pairing));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authError]);

  useEffect(() => {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    const sharedToken = fragment.get("token");
    if (sharedToken) {
      setToken(sharedToken);
      const state = readDeckHistoryState();
      window.history.replaceState(
        state?.__codexDeck
          ? state
          : deckRewrite(undefined, routeForPath(location.pathname, isToolPath)),
        "",
        `${location.pathname}${location.search}`,
      );
    }
    refresh();
  }, [refresh]);

  // 快照落盘节流：流式输出时 thread.updated 一秒好几条，每条都整份
  // stringify 写 localStorage 很费主线程。停顿 1 秒再写；页面切走/关闭时立刻写。
  const pendingSnapshotWrite = useRef<Snapshot | null>(null);
  useEffect(() => {
    if (!hasSidebarData(snapshot)) return;
    pendingSnapshotWrite.current = snapshot;
    const timer = window.setTimeout(() => {
      pendingSnapshotWrite.current = null;
      writeSnapshotCache(snapshot);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [snapshot]);
  useEffect(() => {
    const flush = () => {
      const pending = pendingSnapshotWrite.current;
      if (!pending) return;
      pendingSnapshotWrite.current = null;
      writeSnapshotCache(pending);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // 后台预取最近会话的全文，暖 localStorage 线程缓存：隧道高延迟下点开即见。
  // 只补完全没有缓存的会话（快照本身已按 updatedAt 排序）；已缓存的交给
  // 打开时的条件 GET（If-None-Match/304）刷新，避免反复拉全文。
  // 只看缓存索引、不解析正文，免得为了判断“有没有”把每个会话都读进内存。
  useEffect(() => {
    const cachedKeys = cachedThreadKeys();
    const timers = (snapshot.threads || [])
      .filter(
        (thread) =>
          !cachedKeys.has(sessionKey(thread)) &&
          !isThreadUncacheable(sessionKey(thread)),
      )
      .slice(0, 8)
      .map((thread, index) =>
        window.setTimeout(() => {
          const key = sessionKey(thread);
          dedupeThreadLoad(key, () => fetchThreadFull(thread, key)).catch(
            () => {},
          );
        }, 500 + index * 300),
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [snapshot.threads]);

  useEffect(() => {
    writeUiCache({
      expandedProjects: [...expandedProjects],
      query: "",
    });
  }, [expandedProjects]);

  useEffect(() => {
    const value = query.trim();
    if ([...value].length < 3) {
      setContentSearch(undefined);
      setContentSearchPending(false);
      return;
    }
    setContentSearch(undefined);
    setContentSearchPending(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<SessionSearchResponse>("/session-search", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ query: value, library }),
      })
        .then(setContentSearch)
        .catch((error) => {
          if (error?.name !== "AbortError") setContentSearch(undefined);
        })
        .finally(() => {
          if (!controller.signal.aborted) setContentSearchPending(false);
        });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, library]);

  useEffect(() => {
    if (loading) return;
    const previous = previousThreadStatuses.current;
    const completed = completedThreads(previous, snapshot.threads);
    const visible = document.visibilityState === "visible";

    setUnseenSessions((current) => {
      const next = reconcileUnseenSessions({
        current,
        previous,
        threads: snapshot.threads,
        selected,
        visible,
      });
      if (sameSessionSet(current, next)) return current;
      writeUnseenSessions(next);
      return next;
    });
    previousThreadStatuses.current = threadStatusMap(snapshot.threads);

    const notify = getDeckSettings();
    for (const thread of completed) {
      const key = sessionKey(thread);
      if (visible && selected === key) continue;
      if (!notify.notifyReplies || (notify.notifyOnlyHidden && visible))
        continue;
      sendSystemNotification({
        title: "Codex Deck · 有新回复",
        body: `${thread.name}\n任务已经执行完成`,
        tag: `codex-deck-thread-${key}`,
        onClick: () => openSession(thread),
      });
    }
  }, [loading, openSession, selected, snapshot.threads]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && selected)
        markSessionSeen(selected);
      if (document.visibilityState === "visible")
        setNotificationPermission(systemNotificationPermission());
    };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [markSessionSeen, selected]);

  useEffect(() => {
    const threads = [...snapshot.threads, ...(snapshot.archivedThreads || [])];
    const liveIds = new Set(snapshot.approvals.map((approval) => approval.id));
    // 已决议的 id 及时摘除，否则 Set 随运行时间无限增长。
    for (const id of [...notifiedApprovals.current])
      if (!liveIds.has(id)) notifiedApprovals.current.delete(id);
    const notify = getDeckSettings();
    const visible = document.visibilityState === "visible";
    for (const approval of snapshot.approvals) {
      if (notifiedApprovals.current.has(approval.id)) continue;
      // 先记账再判断开关：关着时到达的审批，之后打开开关也不补发。
      notifiedApprovals.current.add(approval.id);
      if (!notify.notifyApprovals || (notify.notifyOnlyHidden && visible))
        continue;
      const thread = threadForApproval(approval, threads);
      sendSystemNotification({
        title: "Codex Deck · 需要确认",
        body: `${thread?.name || "Codex Session"}\n${approvalPreview(approval)}`,
        tag: `codex-deck-approval-${approval.id}`,
        requireInteraction: true,
        onClick: () => {
          if (thread) openSession(thread);
        },
      });
    }
  }, [
    openSession,
    snapshot.approvals,
    snapshot.archivedThreads,
    snapshot.threads,
  ]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let timer: number;
    let socket: WebSocket | undefined;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws?token=${encodeURIComponent(getToken())}`,
      );
      socket = ws;
      ws.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        // 任何 WS 消息都可能携带比在途 HTTP 快照更新的状态，先推进时钟，
        // 让 refresh 响应落地时能选择保守合并而非整体覆盖。
        wsClockRef.current += 1;
        if (message.type === "snapshot") {
          if (message.data.activities) resetActivities(message.data.activities);
          setSnapshot((current) => reconcileSnapshot(current, message.data));
        } else if (message.type === "activity.updated")
          applyActivityUpdate(message.data);
        else if (message.type === "thread.updated") {
          const next = message.data as ThreadSummary;
          const same = (thread: ThreadSummary) =>
            thread.id === next.id &&
            (thread.agentId || "codex") === (next.agentId || "codex");
          setSnapshot((current) => ({
            ...current,
            threads: next.archived
              ? current.threads.filter((thread) => !same(thread))
              : [
                  next,
                  ...current.threads.filter((thread) => !same(thread)),
                ].sort((a, b) => b.updatedAt - a.updatedAt),
            archivedThreads: next.archived
              ? [
                  next,
                  ...(current.archivedThreads || []).filter(
                    (thread) => !same(thread),
                  ),
                ].sort((a, b) => b.updatedAt - a.updatedAt)
              : (current.archivedThreads || []).filter(
                  (thread) => !same(thread),
                ),
          }));
          setSelected((current) =>
            current?.startsWith(`${next.agentId || "codex"}:`) &&
            current.endsWith(`:${next.id}`)
              ? sessionKey(next)
              : current,
          );
        } else if (message.type === "thread.deleted") {
          const id = message.data.threadId;
          const deletedAgentId = message.data.agentId || "codex";
          const matchesDeleted = (thread: ThreadSummary) =>
            thread.id === id && (thread.agentId || "codex") === deletedAgentId;
          setSnapshot((current) => ({
            ...current,
            threads: current.threads.filter(
              (thread) => !matchesDeleted(thread),
            ),
            archivedThreads: (current.archivedThreads || []).filter(
              (thread) => !matchesDeleted(thread),
            ),
          }));
          setSelected((current) =>
            current === `${deletedAgentId}:${id}` ||
            (current?.startsWith(`${deletedAgentId}:`) &&
              current.endsWith(`:${id}`))
              ? undefined
              : current,
          );
        } else if (message.type === "provider.status")
          setSnapshot((current) => ({
            ...current,
            providers: current.providers.map((provider) =>
              provider.id === message.data.providerId
                ? {
                    ...provider,
                    online: message.data.online,
                    error: message.data.error,
                  }
                : provider,
            ),
          }));
        else if (message.type === "runtime.status")
          setSnapshot((current) => ({
            ...current,
            runtime: {
              starting: false,
              remoteUrl: "",
              ...current.runtime,
              ...message.data,
            },
          }));
        else if (message.type === "approval.requested")
          setSnapshot((current) => ({
            ...current,
            approvals: [
              ...current.approvals.filter(
                (item) =>
                  item.id !== message.data.id ||
                  (item.agentId || "codex") !==
                    (message.data.agentId || "codex"),
              ),
              message.data,
            ],
          }));
        else if (message.type === "approval.updated")
          setSnapshot((current) => ({
            ...current,
            approvals: current.approvals.map((item) =>
              item.id === message.data.id &&
              (item.agentId || "codex") === (message.data.agentId || "codex")
                ? { ...item, ...message.data }
                : item,
            ),
          }));
        else if (message.type === "approval.resolved")
          setSnapshot((current) => ({
            ...current,
            approvals: current.approvals.filter(
              (item) =>
                item.id !== message.data.approvalId ||
                (item.agentId || "codex") !== (message.data.agentId || "codex"),
            ),
          }));
        else if (
          message.type === "codex.event" ||
          message.type === "agent.event"
        )
          setEvents((current) => appendCodexEvent(current, message.data));
      };
      ws.onclose = () => {
        if (!stopped) timer = window.setTimeout(connect, 2500);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [authError]);

  const libraryThreads =
    library === "archived" ? snapshot.archivedThreads || [] : snapshot.threads;
  const historySyncing = Boolean(
    snapshot.agents?.some(
      (agent) =>
        agent.historyStatus === "cached" || agent.historyStatus === "loading",
    ),
  );

  // 基础分组只依赖“库内容”：query/筛选条件变化时复用，不重跑归一化+排序。
  const baseGroups = useMemo(
    () => mergeProjectGroups(snapshot.projects || [], libraryThreads),
    [snapshot.projects, libraryThreads],
  );
  // Welcome 页的最近项目永远看 active 库；切到归档库时才需另算一份。
  const activeGroups = useMemo(
    () =>
      library === "active"
        ? baseGroups
        : mergeProjectGroups(snapshot.projects || [], snapshot.threads),
    [library, baseGroups, snapshot.projects, snapshot.threads],
  );

  const projects = useMemo(() => {
    const contentIds = new Set(
      (contentSearch?.results || []).map(
        (match) => `${match.agentId}:${match.threadId}`,
      ),
    );
    const groups = baseGroups;
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
          : statusFilter === "unseen"
            ? threads.filter((thread) => unseenSessions.has(sessionKey(thread)))
            : threads;
    return filterProjectGroups(
      groups.map((group) => ({
        ...group,
        sessions: statusThreads(group.sessions),
      })),
      query,
      {
        providerName: (id) =>
          snapshot.providers.find((provider) => provider.id === id)?.name || "",
        matchingThread: (thread) =>
          contentIds.has(`${thread.agentId || "codex"}:${thread.id}`),
      },
    ).filter((group) => group.sessions.length > 0);
  }, [
    baseGroups,
    snapshot.providers,
    query,
    statusFilter,
    unseenSessions,
    contentSearch,
  ]);

  const contentMatches = useMemo(() => {
    const matches = new Map<string, SessionSearchMatch>();
    for (const match of contentSearch?.results || []) {
      const key = `${match.agentId}:${match.threadId}`;
      if (!matches.has(key)) matches.set(key, match);
    }
    return matches;
  }, [contentSearch]);

  const counts = useMemo(
    () => ({
      running: snapshot.threads.filter((thread) => thread.status === "running")
        .length,
      waiting: snapshot.threads.filter((thread) => thread.status === "waiting")
        .length,
      errors:
        snapshot.threads.filter((thread) => thread.status === "error").length +
        // 投递无望的唤醒也是「异常」：侧栏角标要与首页需要处理一致。
        (snapshot.wakeDeliveries || []).filter((d) => d.status === "dead")
          .length +
        // 失联的 watcher 同理：远端任务没人盯了。
        (snapshot.wakeLost || []).length,
      unseen: snapshot.threads.filter((thread) =>
        unseenSessions.has(sessionKey(thread)),
      ).length,
    }),
    [
      snapshot.threads,
      snapshot.wakeDeliveries,
      snapshot.wakeLost,
      unseenSessions,
    ],
  );

  const allThreads = useMemo(
    () => [...snapshot.threads, ...(snapshot.archivedThreads || [])],
    [snapshot.threads, snapshot.archivedThreads],
  );

  const forkCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of allThreads) {
      if (!thread.forkedFromId) continue;
      map.set(thread.forkedFromId, (map.get(thread.forkedFromId) || 0) + 1);
    }
    return map;
  }, [allThreads]);

  const current = allThreads.find((thread) => sessionKey(thread) === selected);

  /** 会话的 deck-wake 状态：唤醒代号绑定（wakeCodes）+ 本机 watcher（wakeWatchers）。 */
  const wakeFor = (thread: ThreadSummary) => {
    const key = activityKey(thread.agentId, thread.id);
    const mine = (item: { agentId?: AgentId; threadId?: string }) =>
      Boolean(item.threadId) &&
      activityKey(item.agentId, item.threadId!) === key;
    const watchers = (snapshot.wakeWatchers || []).filter(mine);
    return {
      code: (snapshot.wakeCodes || []).find(mine)?.code,
      watcher: watchers[0],
      watchers,
      lost: (snapshot.wakeLost || []).filter(mine),
    };
  };

  /** 侧栏会话行的 deck-wake 标记，键为 sessionKey。失联优先于监督中。 */
  const wakeStates = useMemo(() => {
    const byAgentKey = new Map<string, SessionWakeState>();
    for (const watcher of snapshot.wakeWatchers || [])
      if (watcher.threadId)
        byAgentKey.set(activityKey(watcher.agentId, watcher.threadId), "watching");
    for (const lost of snapshot.wakeLost || [])
      if (lost.threadId)
        byAgentKey.set(activityKey(lost.agentId, lost.threadId), "lost");
    const map = new Map<string, SessionWakeState>();
    if (!byAgentKey.size) return map;
    for (const thread of allThreads) {
      const state = byAgentKey.get(activityKey(thread.agentId, thread.id));
      if (state) map.set(sessionKey(thread), state);
    }
    return map;
  }, [snapshot.wakeWatchers, snapshot.wakeLost, allThreads]);

  const allThreadsRef = useRef(allThreads);
  allThreadsRef.current = allThreads;

  // selected 与会话 URL 漂移时原地重写条目：供应商切换改了 key、
  // 会话被程序性关闭（删除/归档）都不会留下死 URL。
  useEffect(() => {
    const urlKey = sessionKeyFromPath(location.pathname);
    if (!urlKey || selected === urlKey) return;
    window.history.replaceState(
      deckRewrite(
        readDeckHistoryState(),
        selected
          ? { page: "workspace", view: "session", session: selected }
          : routeForPath("/", isToolPath),
      ),
      "",
      selected ? sessionPath(selected) : "/",
    );
  }, [selected]);

  // URL 指向的会话已不存在（过期/被删）：宽限期后退回工作区。
  // 宽限覆盖“新建会话尚未出现在 snapshot”的窗口。
  useEffect(() => {
    if (!selected || !sessionKeyFromPath(location.pathname)) return;
    if (allThreads.some((thread) => sessionKey(thread) === selected)) return;
    const grace = Math.max(500, 4000 - (Date.now() - selectedAtRef.current));
    const timer = window.setTimeout(() => {
      setSelected((now) =>
        now && !allThreadsRef.current.some((t) => sessionKey(t) === now)
          ? undefined
          : now,
      );
    }, grace);
    return () => window.clearTimeout(timer);
  }, [selected, allThreads]);

  const recentProjects = useMemo(() => {
    const fromPrefs = (snapshot.preferences?.recentDirs || [])
      .map((cwd) =>
        activeGroups.find(
          (group) => group.cwd === cwd || group.key.includes(cwd.toLowerCase()),
        ),
      )
      .filter(Boolean) as ProjectGroup[];
    const fromSessions = activeGroups.filter((group) => group.sessions.length);
    const seen = new Set<string>();
    const list: ProjectGroup[] = [];
    for (const group of [...fromPrefs, ...fromSessions]) {
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      list.push(group);
      if (list.length === 3) break;
    }
    return list;
  }, [snapshot.preferences, activeGroups]);

  // 一个会话都没有（首次使用）时首页退回 Welcome：总览此时没有可看的。
  const showWelcome =
    !current &&
    !query &&
    !loading &&
    !historySyncing &&
    snapshot.threads.length === 0;

  const saveProject = async (
    project: { key: string; cwd: string },
    patch: Partial<Omit<ProjectRecord, "defaults">> & { defaults?: object },
  ) => {
    const next = await put<
      Snapshot & { connectionApplied?: boolean; connectionPending?: boolean }
    >("/projects", {
      key: project.key,
      cwd: project.cwd,
      ...patch,
    });
    // PUT 返回的是服务端生成时点的全量快照：走 reconcile 合并而非整体替换，
    // 避免覆盖响应生成后才到达的 WS 事件。
    setSnapshot((current) => reconcileSnapshot(current, next));
    return next;
  };

  const runOnThreads = async (
    threads: ThreadSummary[],
    work: (thread: ThreadSummary) => Promise<void>,
  ) => {
    const results = await Promise.allSettled(
      threads.map((thread) => work(thread)),
    );
    const failed = results.filter((item) => item.status === "rejected").length;
    return { ok: results.length - failed, failed };
  };

  const selectedInProject = (projectKey: string) =>
    Boolean(current && threadsForProject([current], projectKey).length);

  const archiveProject = (project: ProjectGroup) => {
    const targets = threadsForProject(snapshot.threads, project.key);
    if (!targets.length) {
      pushToast("这个项目没有可归档的现有会话");
      return;
    }
    if (
      targets.some(
        (thread) => !capabilitiesFor(snapshot.agents, thread).archive,
      )
    ) {
      pushToast("项目包含暂不支持归档的 Agent 会话，请逐个处理");
      return;
    }
    const running = targets.some(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
    setConfirm({
      title: "归档项目",
      body: (
        <p>
          将归档 <b>{project.name}</b> 下的 <b>{targets.length}</b>{" "}
          个现有会话？可在归档箱恢复。 不会改动磁盘上的项目文件。
          {running ? " 运行中或待确认的会话可能无法归档。" : ""}
        </p>
      ),
      confirmLabel: "归档项目",
      run: async () => {
        const { ok, failed } = await runOnThreads(targets, (thread) =>
          post(threadArchivePath(thread, "archive")).then(() => undefined),
        );
        await saveProject(project, { hidden: true });
        if (selectedInProject(project.key)) setSelected(undefined);
        await refresh();
        pushToast(
          failed
            ? `已归档 ${ok} 个会话，${failed} 个失败`
            : `已归档 ${project.name} 的 ${ok} 个会话`,
        );
      },
    });
  };

  const restoreProject = (project: ProjectGroup) => {
    const targets = threadsForProject(
      snapshot.archivedThreads || [],
      project.key,
    );
    if (!targets.length) {
      pushToast("这个项目没有可恢复的归档会话");
      return;
    }
    setConfirm({
      title: "恢复项目",
      body: (
        <p>
          将恢复 <b>{project.name}</b> 下的 <b>{targets.length}</b>{" "}
          个归档会话到现有库？
        </p>
      ),
      confirmLabel: "恢复项目",
      run: async () => {
        const { ok, failed } = await runOnThreads(targets, (thread) =>
          post(threadArchivePath(thread, "unarchive")).then(() => undefined),
        );
        await saveProject(project, { hidden: false });
        await refresh();
        setLibrary("active");
        pushToast(
          failed
            ? `已恢复 ${ok} 个会话，${failed} 个失败`
            : `已恢复 ${project.name} 的 ${ok} 个会话`,
        );
      },
    });
  };

  const deleteProject = (project: ProjectGroup) => {
    const targets = threadsForProject(allThreads, project.key);
    if (
      targets.some(
        (thread) => !capabilitiesFor(snapshot.agents, thread).archive,
      )
    ) {
      pushToast("项目包含暂不支持删除的 Agent 会话，不能批量删除项目");
      return;
    }
    setConfirm({
      title: "删除项目",
      body: (
        <p>
          确定永久删除 <b>{project.name}</b>
          {targets.length ? ` 及其下 ${targets.length} 个会话` : ""}？
          {targets.length ? " 会话不可恢复。" : ""}
          不会删除磁盘上的项目文件。
        </p>
      ),
      confirmLabel: "删除项目",
      danger: true,
      run: async () => {
        const { ok, failed } = await runOnThreads(targets, (thread) =>
          remove(threadRemovePath(thread)).then(() => undefined),
        );
        if (failed) {
          await refresh();
          pushToast(`已删除 ${ok} 个会话，${failed} 个失败，项目未移除`);
          return;
        }
        const afterRemove = await remove("/projects", { key: project.key });
        setSnapshot((current) => reconcileSnapshot(current, afterRemove));
        if (selectedInProject(project.key)) setSelected(undefined);
        await refresh();
        pushToast(
          targets.length
            ? `已删除 ${project.name} 及 ${ok} 个会话`
            : `已删除项目 ${project.name}`,
        );
      },
    });
  };

  const selectThread = (thread: ThreadSummary, match?: SessionSearchMatch) => {
    setSearchTarget(
      match
        ? {
            session: sessionKey(thread),
            turnId: match.turnId,
            itemId: match.itemId,
            query,
            request: performance.now(),
          }
        : undefined,
    );
    openSession(thread);
  };

  const enableSystemNotifications = async () => {
    const permission = await requestSystemNotifications();
    setNotificationPermission(permission);
    pushToast(
      permission === "granted"
        ? "已开启系统提醒"
        : permission === "unsupported"
          ? "当前浏览器不支持系统提醒"
          : "系统提醒未获授权",
    );
  };

  const submitApproval = async (id: string, body: ApprovalResolveBody) => {
    const approval = snapshot.approvals.find((item) => item.id === id);
    if (!approval) throw new Error("审批请求已不存在");
    await post(approvalPath(approval), body);
    await refresh();
  };

  const resolveApproval = async (id: string, body: ApprovalResolveBody) => {
    try {
      await submitApproval(id, body);
    } catch (error: any) {
      pushToast(error?.message || "审批处理失败");
    }
  };

  const openOrigin = (thread: ThreadSummary) => {
    if (!thread.forkedFromId) return;
    const source = allThreads.find((item) => item.id === thread.forkedFromId);
    if (!source) return;
    setLibrary(source.archived ? "archived" : "active");
    openSessionKey(sessionKey(source));
  };

  const origin = current?.forkedFromId
    ? (() => {
        const source = allThreads.find(
          (item) => item.id === current.forkedFromId,
        );
        return source
          ? {
              name: source.name,
              archived: Boolean(source.archived),
            }
          : { name: "源会话" };
      })()
    : undefined;

  const chatWorkspace = current ? (
    <RenderErrorBoundary
      resetKey={sessionKey(current)}
      fallback={
        <main className="chat">
          <header className="chat-header">
            <div className="chat-header-row1">
              <button
                className="icon-btn mobile-back"
                onClick={leaveToWorkspace}
                title="返回"
              >
                <ArrowLeft />
              </button>
              <div className="chat-title">
                <h2>会话无法显示</h2>
              </div>
            </div>
          </header>
          <p className="error-banner">
            这个会话的内容触发了渲染错误。请返回列表，或刷新后再试。
          </p>
        </main>
      }
    >
      <ChatWorkspace
        key={sessionKey(current)}
        thread={current}
        provider={providerForThread(
          snapshot.providers,
          snapshot.agentProfiles,
          current,
        )}
        agentName={agentName(snapshot.agents, current)}
        capabilities={capabilitiesFor(snapshot.agents, current)}
        messageDeliveries={snapshot.messageDeliveries}
        approvals={snapshot.approvals}
        events={events}
        origin={origin}
        searchTarget={
          searchTarget?.session === sessionKey(current)
            ? searchTarget
            : undefined
        }
        onBack={leaveToWorkspace}
        onSnapshot={refresh}
        onSwitchProvider={() => setSwitchThread(current)}
        onMenu={() => setSheet(current)}
        onSelectThread={(providerId, threadId) =>
          openSessionKey(
            sessionKey({
              agentId: current.agentId,
              providerId,
              id: threadId,
            }),
          )
        }
        onToast={pushToast}
        onUsage={() => setUsageOpen("stats")}
        onTasks={() => setTaskScope(current.id)}
        onAppearance={() => setSettingsModal({ tab: "interface" })}
        onOpenOrigin={() => openOrigin(current)}
        wake={wakeFor(current)}
        onWake={() => setWakeThread(current)}
      />
    </RenderErrorBoundary>
  ) : undefined;

  if (authError)
    return (
      <div className="auth-page">
        <div className="auth-card">
          <span>
            <KeyRound />
          </span>
          <h1>连接 Codex Deck</h1>
          <p>
            {pairingAvailable
              ? "输入终端里显示的 6 位配对验证码，或直接粘贴访问令牌。令牌只保存在这个浏览器中。"
              : "输入服务端设置的 REMOTE_TOKEN。令牌只保存在这个浏览器中。"}
          </p>
          {pairingAvailable && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = new FormData(event.currentTarget).get(
                    "code",
                  ) as string;
                  if (!/^\d{6}$/.test(value.trim())) {
                    setPairMessage("验证码应为 6 位数字");
                    return;
                  }
                  setPairMessage("");
                  pairWithCode(value.trim())
                    .then(({ token: paired }) => {
                      setToken(paired);
                      setAuthError(false);
                      refresh();
                    })
                    .catch((error: any) =>
                      setPairMessage(error?.message || "配对失败"),
                    );
                }}
              >
                <input
                  autoFocus
                  required
                  name="code"
                  inputMode="numeric"
                  maxLength={6}
                  pattern="\d{6}"
                  placeholder="6 位验证码"
                />
                <button className="primary">验证并连接</button>
              </form>
              {pairMessage && <p className="auth-error">{pairMessage}</p>}
              <div className="auth-divider">或</div>
            </>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get(
                "token",
              ) as string;
              setToken(value);
              setAuthError(false);
              refresh();
            }}
          >
            <input name="token" type="password" placeholder="访问令牌" />
            <button className="primary">连接</button>
          </form>
        </div>
      </div>
    );

  if (page === "tools")
    return (
      <>
        <ToolCenter
          tools={snapshot.tools}
          initialCwd={current?.cwd}
          directories={[
            ...(current?.cwd ? [current.cwd] : []),
            ...(snapshot.preferences?.recentDirs || []),
            ...(snapshot.projects || []).map((project) => project.cwd),
            ...allThreads.map((thread) => thread.cwd),
          ].filter(
            (value, index, values) =>
              Boolean(value) && values.indexOf(value) === index,
          )}
          onToast={pushToast}
          onClose={leaveToWorkspace}
        />
        <ToastStack toasts={toasts} />
      </>
    );

  // 桌面端工具默认新开浏览器页：同源 localStorage 共享令牌，不占当前会话的
  // 导航栈。移动端（尤其装成 PWA 时）新标签页会跳出应用，改为应用内压栈打开。
  const openTool = (pathname = "/terminal") => {
    if (!mobile && getDeckSettings().toolOpenTarget === "tab") {
      window.open(`${location.origin}${pathname}`, "_blank", "noopener");
      return;
    }
    window.history.pushState(
      deckEntry(readDeckHistoryState(), { page: "tools", view: "workspace" }),
      "",
      pathname,
    );
    setSelected(undefined);
    setSessionsView(false);
    setPage("tools");
  };

  const quickProjects = quickNewProjects(activeGroups);
  const openNewFromTabBar = () => {
    // 没有可选项目时直接进新建弹窗，省掉一层空面板。
    if (quickProjects.length) setMobileSheet("new");
    else setThreadModal({});
  };
  const showTabBar = mobile && !current;

  return (
    <div className={`app-shell${showTabBar ? " has-tabbar" : ""}`}>
      <Sidebar
        show={sessionsView}
        hiddenOnMobile={Boolean(current)}
        homeActive={!current}
        projectCount={activeGroups.length}
        sessionCount={snapshot.threads.length}
        archivedCount={(snapshot.archivedThreads || []).length}
        library={library}
        query={query}
        searchMatches={contentMatches}
        contentSearchPending={contentSearchPending}
        contentSearchProgress={
          contentSearch
            ? {
                indexed: contentSearch.indexed,
                total: contentSearch.total,
                building: contentSearch.building,
              }
            : undefined
        }
        statusFilter={statusFilter}
        counts={counts}
        projects={projects}
        wakeStates={wakeStates}
        selected={selected}
        unseenSessions={unseenSessions}
        expandedProjects={expandedProjects}
        forkCounts={forkCounts}
        runtime={snapshot.runtime}
        notificationPermission={notificationPermission}
        archiveError={snapshot.runtime?.archiveError}
        loading={loading || historySyncing}
        onClose={goHome}
        onNew={() => openThreadModalFromSidebar({})}
        onRefresh={refresh}
        onProviders={() => setSettingsModal({})}
        onUsage={setUsageOpen}
        onTasks={() => setTaskScope(null)}
        onTools={openTool}
        onNotifications={enableSystemNotifications}
        onLibrary={setLibrary}
        onQuery={setQuery}
        onStatusFilter={setStatusFilter}
        onHome={goHome}
        onToggleProject={(key) =>
          setExpandedProjects((currentSet) => {
            const next = new Set(currentSet);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
          })
        }
        onSelect={selectThread}
        onAddInProject={(project) =>
          openThreadModalFromSidebar({
            cwd: project.cwd,
            project: snapshot.projects?.find(
              (item) => item.key === project.key,
            ),
          })
        }
        onPin={(project) => saveProject(project, { pinned: !project.pinned })}
        onHide={(project) => saveProject(project, { hidden: true })}
        onRenameProject={(project) => setRename({ kind: "project", project })}
        onDefaults={(project) =>
          setProjectEdit(
            snapshot.projects?.find((item) => item.key === project.key) || {
              key: project.key,
              cwd: project.cwd,
              name: project.name,
              defaults: project.defaults,
              updatedAt: project.updatedAt,
            },
          )
        }
        onArchiveProject={archiveProject}
        onRestoreProject={restoreProject}
        onDeleteProject={deleteProject}
        onHistory={setHistoryHelp}
        onSessionMenu={setSheet}
        providers={snapshot.providers}
      />
      <section className="workspace">
        {showWelcome && (
          <button
            type="button"
            className="icon-btn appearance-trigger appearance-trigger-home"
            onClick={() => setSettingsModal({ tab: "interface" })}
            title="外观设置"
            aria-label="外观设置"
          >
            <SunMoon />
          </button>
        )}
        {current ? (
          chatWorkspace
        ) : showWelcome ? (
          <Welcome
            recent={recentProjects}
            runtime={snapshot.runtime}
            loading={loading || historySyncing}
            onNew={() => setThreadModal({})}
            onOpenProject={(project) =>
              setThreadModal({
                cwd: project.cwd,
                project: snapshot.projects?.find(
                  (item) => item.key === project.key,
                ),
              })
            }
            onUsage={() => setUsageOpen("stats")}
          />
        ) : (
          <MonitorPanel
            groups={query ? projects : activeGroups}
            unseenSessions={unseenSessions}
            approvals={snapshot.approvals}
            providers={snapshot.providers}
            agents={snapshot.agents || []}
            runtime={snapshot.runtime}
            threads={allThreads}
            liveThreads={snapshot.threads}
            deliveries={snapshot.wakeDeliveries || []}
            watchers={snapshot.wakeWatchers}
            lostWatchers={snapshot.wakeLost || []}
            searchMatches={contentMatches}
            query={query}
            loading={loading || historySyncing}
            notificationPermission={notificationPermission}
            onSelect={selectThread}
            onOpenThread={openSession}
            onShowAll={openSessions}
            onNew={() => setThreadModal({})}
            onAppearance={() => setSettingsModal({ tab: "interface" })}
            onMarkSeen={markSessionSeen}
            onMarkAllSeen={markAllSeen}
            onSessionMenu={setSheet}
            onHistory={setHistoryHelp}
            onResolveApproval={submitApproval}
            onRequestNotifications={enableSystemNotifications}
            onRefreshLimits={refreshOfficialUsage}
            onOpenUsage={setUsageOpen}
            onOpenAgentSettings={() => setSettingsModal({ tab: "agents" })}
          />
        )}
      </section>
      {showTabBar && (
        <MobileTabBar
          active={sessionsView ? "sessions" : "home"}
          homeBadge={counts.waiting + counts.errors}
          sessionsBadge={counts.unseen}
          onHome={goHome}
          onSessions={openSessions}
          onNew={openNewFromTabBar}
          onTools={() => setMobileSheet("tools")}
          onSettings={() => setSettingsModal({})}
        />
      )}
      {mobileSheet === "tools" && (
        <ActionSheet
          title="工具"
          onClose={() => setMobileSheet(null)}
          actions={[
            ...[
              {
                id: "terminal",
                label: "终端",
                detail: "打开 Web Terminal",
                icon: <Terminal />,
                onClick: () => openTool("/terminal"),
              },
              {
                id: "git",
                label: "Git 管理",
                detail: "改动、提交与分支",
                icon: <GitBranch />,
                onClick: () => openTool("/git"),
              },
              {
                id: "text-editor",
                label: "文本编辑器",
                detail: "查看与编辑宿主机文件",
                icon: <FileText />,
                onClick: () => openTool("/text-editor"),
              },
              {
                id: "commands",
                label: "快捷指令",
                detail: "在指定目录一键执行常用指令",
                icon: <Zap />,
                onClick: () => openTool("/commands"),
              },
            ]
              .filter((item) => !hiddenTools.includes(item.id))
              .map(({ id: _id, ...item }) => item),
            {
              label: "任务",
              detail:
                counts.running + counts.waiting > 0
                  ? `${counts.running + counts.waiting} 个进行中`
                  : "后台任务与进度",
              icon: <Activity />,
              onClick: () => setTaskScope(null),
            },
            {
              label: "用量统计",
              detail: "按会话与项目查看",
              icon: <BarChart3 />,
              onClick: () => setUsageOpen("stats"),
            },
            {
              label: "Codex 额度",
              detail: "Official 账号额度状态",
              icon: <Gauge />,
              onClick: () => setUsageOpen("limits"),
            },
            ...(notificationPermission !== "unsupported"
              ? [
                  {
                    label: "系统提醒",
                    detail:
                      notificationPermission === "granted"
                        ? "已开启"
                        : notificationPermission === "denied"
                          ? "浏览器已阻止"
                          : "审批与任务通知",
                    icon: <BellRing />,
                    disabled: notificationPermission === "denied",
                    onClick: enableSystemNotifications,
                  },
                ]
              : []),
          ]}
        />
      )}
      {mobileSheet === "new" && (
        <ActionSheet
          title="新建会话"
          onClose={() => setMobileSheet(null)}
          actions={[
            ...quickProjects.map((project) => ({
              key: project.key,
              label: project.name,
              detail: project.cwd,
              icon: <Folder />,
              onClick: () =>
                setThreadModal({
                  cwd: project.cwd,
                  project: snapshot.projects?.find(
                    (item) => item.key === project.key,
                  ),
                }),
            })),
            {
              key: "__other",
              label: "其他目录…",
              detail: "手动输入或浏览路径",
              icon: <FolderPlus />,
              onClick: () => setThreadModal({}),
            },
          ]}
        />
      )}
      {settingsModal && (
        <SettingsModal
          snapshot={snapshot}
          appearance={appearance}
          notificationPermission={notificationPermission}
          defaultCwd={current?.cwd}
          initialTab={settingsModal.tab}
          onRequestNotifications={enableSystemNotifications}
          onOpenTool={(path) => {
            // 在当前页打开工具会切走整个工作区，设置一并收起。
            if (mobile || getDeckSettings().toolOpenTarget === "inline")
              setSettingsModal(false);
            openTool(path);
          }}
          onClose={() => setSettingsModal(false)}
          onSaved={setSnapshot}
          onToast={pushToast}
          onConfirm={(spec, run) => setConfirm({ ...spec, run })}
          onConfirmDelete={(provider, run) =>
            setConfirm({
              title: "删除供应商",
              body: (
                <p>
                  确定删除 <b>{provider.name}</b>？现有 Session 历史不会删除。
                </p>
              ),
              danger: true,
              confirmLabel: "删除",
              run,
            })
          }
          onConfirmRuntimeRestart={(run) =>
            setConfirm({
              title: "保存上下文设置并重启？",
              body: (
                <p>
                  新设置需要重启共享的 <b>Codex Runtime</b> 才能生效。
                  现有历史不会删除；如果有任务正在运行或等待审批，本次保存会被拒绝。
                </p>
              ),
              confirmLabel: "保存并重启",
              run,
            })
          }
        />
      )}
      {threadModal && (
        <NewThreadModal
          agents={snapshot.agents || []}
          agentProfiles={snapshot.agentProfiles || []}
          providers={snapshot.providers}
          initialCwd={threadModal.cwd}
          project={threadModal.project}
          preferences={snapshot.preferences}
          runtimeWsl={Boolean(snapshot.runtime?.runtimeWsl)}
          onClose={() => setThreadModal(null)}
          onCreated={(agentId, providerId, id, thread) => {
            const key = sessionKey({ agentId, providerId, id });
            // POST 响应已带会话元数据：先回种缓存，ChatWorkspace 首帧即渲染，
            // 随后的 GET 只做后台刷新，隧道下不再空屏等往返。
            writeThreadCache(key, { ...thread, turns: [] });
            openSessionKey(key);
            setLibrary("active");
            setTimeout(refresh, 400);
          }}
        />
      )}
      {switchThread && (
        <ProviderSwitchModal
          thread={switchThread}
          providers={snapshot.providers}
          agentProfiles={snapshot.agentProfiles || []}
          onClose={() => setSwitchThread(null)}
          onCreated={(providerId, threadId, thread) => {
            const key = sessionKey({
              agentId: switchThread.agentId,
              providerId,
              id: threadId,
            });
            if (thread) writeThreadCache(key, { ...thread, turns: [] });
            else {
              // Claude 换供应商不改会话内容：把旧 key 的缓存搬到新 key。
              const cached = readThreadCache(sessionKey(switchThread));
              if (cached) writeThreadCache(key, cached);
            }
            openSessionKey(key);
            setTimeout(refresh, 300);
          }}
        />
      )}
      {rename?.kind === "thread" && (
        <RenameModal
          title="重命名会话"
          initial={rename.thread.name}
          onClose={() => setRename(null)}
          onSubmit={async (name) => {
            await api(threadPath(rename.thread), {
              method: "PATCH",
              body: JSON.stringify({ name }),
            });
            refresh();
          }}
        />
      )}
      {rename?.kind === "project" && (
        <RenameModal
          title="重命名项目"
          initial={rename.project.name}
          onClose={() => setRename(null)}
          onSubmit={async (name) => {
            await saveProject(rename.project, { name });
          }}
        />
      )}
      {projectEdit && (
        <ProjectDefaultsModal
          project={projectEdit}
          agents={snapshot.agents || []}
          providers={snapshot.providers}
          preferences={snapshot.preferences}
          onClose={() => setProjectEdit(null)}
          onSave={async (defaults, name) => {
            const next = await saveProject(projectEdit, { defaults, name });
            pushToast(
              next.connectionApplied
                ? "已保存，并已应用到 Runtime"
                : next.connectionPending
                  ? "已保存。有会话在运行，空闲后可在「设置 › 供应商」中应用"
                  : "以后在此目录新建将使用这些设置",
            );
          }}
        />
      )}
      {historyHelp && (
        <Modal title="历史会话" onClose={() => setHistoryHelp(null)}>
          <p>
            这条记录来自已有 Codex 历史，可以查看内容。Deck 不会假接管外部 stdin
            会话。
          </p>
          <button
            className="primary"
            type="button"
            onClick={async () => {
              const result = await api<{ command: string }>(
                `/runtime/terminal-command?cwd=${encodeURIComponent(historyHelp.cwd)}`,
              );
              if (await copyText(result.command)) pushToast("已复制");
              else pushToast("复制失败");
            }}
          >
            复制 --remote 命令
          </button>
        </Modal>
      )}
      {sheet && (
        <ActionSheet
          title={sheet.name}
          onClose={() => setSheet(null)}
          actions={[
            ...(sheet.cwd
              ? [
                  {
                    label: "在此项目新建会话",
                    onClick: () => {
                      const key = normalizeProjectPath(sheet.cwd);
                      setThreadModal({
                        cwd: sheet.cwd,
                        project: snapshot.projects?.find(
                          (item) =>
                            normalizeProjectPath(item.key || item.cwd) === key,
                        ),
                      });
                    },
                  },
                ]
              : []),
            {
              label: "重命名",
              disabled: !capabilitiesFor(snapshot.agents, sheet)
                .sessionSettings,
              onClick: () => setRename({ kind: "thread", thread: sheet }),
            },
            {
              label: "会话设置",
              // 设置面板绑定当前打开的会话；从总览/列表对别的会话点开时不可用。
              disabled:
                !capabilitiesFor(snapshot.agents, sheet).sessionSettings ||
                sessionKey(sheet) !== selected,
              onClick: () => setPhoneSettings(true),
            },
            {
              label: "远程唤醒",
              onClick: () => setWakeThread(sheet),
            },
            {
              label: "压缩上下文",
              disabled:
                (sheet.agentId || "codex") !== "codex" &&
                sheet.agentId !== "opencode",
              onClick: () =>
                post(
                  sheet.agentId === "opencode"
                    ? `${threadPath(sheet)}/compact`
                    : `/threads/${sheet.providerId}/${sheet.id}/compact`,
                ).then(refresh),
            },
            {
              label: "审查当前改动",
              disabled: !capabilitiesFor(snapshot.agents, sheet).review,
              onClick: () =>
                post(`/threads/${sheet.providerId}/${sheet.id}/review`).then(
                  refresh,
                ),
            },
            {
              label: "复制为整段分支",
              disabled:
                !capabilitiesFor(snapshot.agents, sheet).fork ||
                sheet.status === "running" ||
                sheet.status === "waiting",
              onClick: async () => {
                const created = await post(
                  `/threads/${sheet.providerId}/${sheet.id}/fork`,
                  {},
                );
                openSessionKey(
                  sessionKey({
                    agentId: sheet.agentId,
                    providerId: sheet.providerId,
                    id: created.id,
                  }),
                );
                refresh();
              },
            },
            {
              label: "切换供应商",
              disabled:
                sheet.status === "running" ||
                sheet.status === "waiting" ||
                ((sheet.agentId || "codex") !== "codex" &&
                  sheet.agentId !== "claude"),
              onClick: () => setSwitchThread(sheet),
            },
            {
              label: sheet.archived ? "恢复会话" : "归档会话",
              disabled: !capabilitiesFor(snapshot.agents, sheet).archive,
              onClick: () =>
                setConfirm({
                  title: sheet.archived ? "恢复会话" : "归档会话",
                  body: (
                    <p>
                      {sheet.archived ? "恢复" : "归档"} <b>{sheet.name}</b>？
                    </p>
                  ),
                  confirmLabel: sheet.archived ? "恢复" : "归档",
                  run: async () => {
                    await post(
                      threadArchivePath(
                        sheet,
                        sheet.archived ? "unarchive" : "archive",
                      ),
                    );
                    if (sessionKey(sheet) === selected) setSelected(undefined);
                    refresh();
                  },
                }),
            },
            {
              label: "永久删除",
              danger: true,
              disabled:
                !capabilitiesFor(snapshot.agents, sheet).delete ||
                (sheet.agentId === "claude" &&
                  (sheet.status === "running" || sheet.status === "waiting")),
              onClick: () =>
                setConfirm({
                  title: "永久删除会话",
                  body: (
                    <p>
                      确定永久删除 <b>{sheet.name}</b>？此操作不可恢复。
                      {sheet.agentId === "claude" && sheet.claudeConnected && (
                        <>
                          Deck 当前持有此会话的 Claude
                          连接。删除会先终止该连接及其中仍在运行的后台任务。
                        </>
                      )}
                    </p>
                  ),
                  confirmLabel:
                    sheet.agentId === "claude" && sheet.claudeConnected
                      ? "关闭连接并删除"
                      : "删除",
                  danger: true,
                  run: async () => {
                    await remove(
                      threadPath(sheet),
                      sheet.agentId === "claude" && sheet.claudeConnected
                        ? { closeConnection: true }
                        : undefined,
                    );
                    if (sessionKey(sheet) === selected) setSelected(undefined);
                    refresh();
                  },
                }),
            },
          ]}
        />
      )}
      {wakeThread && (
        <WakeModal
          thread={wakeThread}
          watchers={wakeFor(wakeThread).watchers}
          lost={wakeFor(wakeThread).lost}
          onClose={() => setWakeThread(null)}
        />
      )}
      {phoneSettings &&
        current &&
        capabilitiesFor(snapshot.agents, current).sessionSettings && (
          <Modal title="会话设置" onClose={() => setPhoneSettings(false)}>
            <div className="phone-session-settings">
              <SessionToolbar
                thread={current}
                variant="panel"
                locked={
                  current.status === "running" || current.status === "waiting"
                }
                onSettings={async (settings) => {
                  await api(threadPath(current), {
                    method: "PATCH",
                    body: JSON.stringify({ settings }),
                  });
                  refresh();
                }}
                onCompact={() =>
                  post(
                    `/threads/${current.providerId}/${current.id}/compact`,
                  ).then(refresh)
                }
              />
            </div>
          </Modal>
        )}
      {usageOpen && (
        <UsageDrawer
          runtime={snapshot.runtime}
          threads={allThreads}
          projects={snapshot.projects}
          currentSessionKey={current ? sessionKey(current) : undefined}
          initialView={usageOpen}
          onRefreshLimits={refreshOfficialUsage}
          onClose={() => setUsageOpen(null)}
        />
      )}
      {taskScope !== undefined && (
        <TaskCenter
          scopeThreadId={taskScope || undefined}
          statusVersion={snapshot.threads
            .filter((thread) => ["running", "waiting"].includes(thread.status))
            .map(
              (thread) =>
                `${thread.agentId || "codex"}:${thread.id}:${thread.status}:${thread.activeTurnId || ""}`,
            )
            .join("|")}
          onOpenThread={(agentId, threadId) => {
            const thread = allThreads.find(
              (item) =>
                (item.agentId || "codex") === agentId && item.id === threadId,
            );
            if (thread) openSession(thread);
            setTaskScope(undefined);
          }}
          onToast={pushToast}
          onClose={() => setTaskScope(undefined)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await confirm.run();
              setConfirm(null);
            } catch (error: any) {
              pushToast(error?.message || "操作失败");
            }
          }}
        />
      )}
      {/* 总览首页自带审批卡片，浮窗再叠一份就重复了；搜索时首页让给结果。 */}
      {(current || query || showWelcome || (mobile && sessionsView)) && (
        <ApprovalInbox
          approvals={snapshot.approvals}
          threads={allThreads}
          notificationPermission={notificationPermission}
          onRequestNotifications={enableSystemNotifications}
          onOpenThread={openSession}
          onResolve={submitApproval}
        />
      )}
      <ToastStack toasts={toasts} />
    </div>
  );
}
