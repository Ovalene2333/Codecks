import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, KeyRound, Menu, Settings } from "lucide-react";
import { api, getSnapshot, getToken, post, put, remove, setToken } from "./api";
import { useAppearance } from "./appearance";
import type {
  ProjectRecord,
  RuntimeSnapshot,
  Snapshot,
  ApprovalResolveBody,
  ThreadSummary,
} from "./types";
import {
  filterProjectGroups,
  mergeProjectGroups,
  threadsForProject,
  type ProjectGroup,
} from "./projects";
import { sessionKey } from "./format";
import {
  hasSidebarData,
  readSnapshotCache,
  readUiCache,
  writeSnapshotCache,
  writeUiCache,
} from "./cache";
import {
  ActionSheet,
  ConfirmDialog,
  RenderErrorBoundary,
  ToastStack,
} from "./ui";
import { Sidebar } from "./layout/Sidebar";
import { ChatWorkspace } from "./session/ChatWorkspace";
import { Welcome } from "./welcome/Welcome";
import { NewThreadModal } from "./overlays/NewThreadModal";
import { ProviderModal } from "./overlays/ProviderModal";
import { ProviderSwitchModal } from "./overlays/ProviderSwitchModal";
import { RenameModal } from "./overlays/RenameModal";
import { ProjectDefaultsModal } from "./overlays/ProjectDefaultsModal";
import { UsageDrawer } from "./usage/UsageChip";
import { SessionToolbar } from "./layout/SessionToolbar";
import { Modal } from "./ui";
import { appendCodexEvent } from "./session/streaming";
import { AppearanceSettingsModal } from "./overlays/AppearanceSettingsModal";
import { ApprovalInbox } from "./overlays/ApprovalInbox";
import {
  completedThreads,
  readUnseenSessions,
  reconcileUnseenSessions,
  sameSessionSet,
  threadStatusMap,
  writeUnseenSessions,
} from "./session/activity";
import { approvalPreview, threadForApproval } from "./session/approvals";
import {
  requestSystemNotifications,
  sendSystemNotification,
  systemNotificationPermission,
} from "./notifications";

const empty: Snapshot = { providers: [], threads: [], approvals: [] };

export function App() {
  const appearance = useAppearance();
  const [snapshot, setSnapshot] = useState(() => readSnapshotCache() || empty);
  const [loading, setLoading] = useState(
    () => !hasSidebarData(readSnapshotCache()),
  );
  const [selected, setSelected] = useState<string>();
  const [library, setLibrary] = useState<"active" | "archived">("active");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(readUiCache().expandedProjects),
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
    "all" | "active" | "attention" | "unseen"
  >("all");
  const [unseenSessions, setUnseenSessions] = useState(readUnseenSessions);
  const [notificationPermission, setNotificationPermission] = useState(
    systemNotificationPermission,
  );
  const [sidebar, setSidebar] = useState(true);
  const [authError, setAuthError] = useState(false);
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
  const [usageOpen, setUsageOpen] = useState(false);
  const [projectEdit, setProjectEdit] = useState<ProjectRecord | null>(null);
  const [historyHelp, setHistoryHelp] = useState<ThreadSummary | null>(null);
  const [sheet, setSheet] = useState<ThreadSummary | null>(null);
  const [phoneSettings, setPhoneSettings] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const previousThreadStatuses = useRef(threadStatusMap(snapshot.threads));
  const notifiedApprovals = useRef(new Set<string>());

  const pushToast = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      2000,
    );
  }, []);

  const markSessionSeen = useCallback((key: string) => {
    setUnseenSessions((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      writeUnseenSessions(next);
      return next;
    });
  }, []);

  const openSession = useCallback(
    (thread: ThreadSummary) => {
      const key = sessionKey(thread);
      markSessionSeen(key);
      setSelected(key);
      setLibrary(thread.archived ? "archived" : "active");
      setSidebar(false);
    },
    [markSessionSeen],
  );

  const refreshOfficialUsage = useCallback(async () => {
    try {
      const runtime = await post<RuntimeSnapshot>("/runtime/rate-limits");
      setSnapshot((current) => ({ ...current, runtime }));
    } catch (error: any) {
      pushToast(error?.message || "Official 额度刷新失败");
    }
  }, [pushToast]);

  const refresh = useCallback(() => {
    setLoading(true);
    return getSnapshot()
      .then((next) => {
        setSnapshot(next);
        writeSnapshotCache(next);
        setAuthError(false);
      })
      .catch((error) => {
        if (error.message.includes("令牌")) setAuthError(true);
      })
      .finally(() => setLoading(false));
  }, []);

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
    if (hasSidebarData(snapshot)) writeSnapshotCache(snapshot);
  }, [snapshot]);

  useEffect(() => {
    writeUiCache({
      expandedProjects: [...expandedProjects],
      query: "",
    });
  }, [expandedProjects]);

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

    for (const thread of completed) {
      const key = sessionKey(thread);
      if (visible && selected === key) continue;
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
    for (const approval of snapshot.approvals) {
      if (notifiedApprovals.current.has(approval.id)) continue;
      notifiedApprovals.current.add(approval.id);
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
        if (message.type === "snapshot") setSnapshot(message.data);
        else if (message.type === "thread.updated") {
          const next = message.data as ThreadSummary;
          const same = (thread: ThreadSummary) =>
            thread.id === next.id && thread.providerId === next.providerId;
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
        } else if (message.type === "thread.deleted") {
          const id = message.data.threadId;
          setSnapshot((current) => ({
            ...current,
            threads: current.threads.filter((thread) => thread.id !== id),
            archivedThreads: (current.archivedThreads || []).filter(
              (thread) => thread.id !== id,
            ),
          }));
          setSelected((current) =>
            current?.endsWith(`:${id}`) ? undefined : current,
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
                (item) => item.id !== message.data.id,
              ),
              message.data,
            ],
          }));
        else if (message.type === "approval.updated")
          setSnapshot((current) => ({
            ...current,
            approvals: current.approvals.map((item) =>
              item.id === message.data.id ? { ...item, ...message.data } : item,
            ),
          }));
        else if (message.type === "approval.resolved")
          setSnapshot((current) => ({
            ...current,
            approvals: current.approvals.filter(
              (item) => item.id !== message.data.approvalId,
            ),
          }));
        else if (message.type === "codex.event")
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

  const projects = useMemo(() => {
    const groups = mergeProjectGroups(snapshot.projects || [], libraryThreads);
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
      },
    ).filter((group) => group.sessions.length > 0);
  }, [
    snapshot.projects,
    snapshot.providers,
    libraryThreads,
    query,
    statusFilter,
    unseenSessions,
  ]);

  const counts = useMemo(
    () => ({
      running: snapshot.threads.filter((thread) => thread.status === "running")
        .length,
      waiting: snapshot.threads.filter((thread) => thread.status === "waiting")
        .length,
      errors: snapshot.threads.filter((thread) => thread.status === "error")
        .length,
      unseen: snapshot.threads.filter((thread) =>
        unseenSessions.has(sessionKey(thread)),
      ).length,
    }),
    [snapshot.threads, unseenSessions],
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

  const recentProjects = useMemo(() => {
    const fromPrefs = (snapshot.preferences?.recentDirs || [])
      .map((cwd) =>
        mergeProjectGroups(snapshot.projects || [], snapshot.threads).find(
          (group) => group.cwd === cwd || group.key.includes(cwd.toLowerCase()),
        ),
      )
      .filter(Boolean) as ProjectGroup[];
    const fromSessions = mergeProjectGroups(
      snapshot.projects || [],
      snapshot.threads,
    ).filter((group) => group.sessions.length);
    const seen = new Set<string>();
    const list: ProjectGroup[] = [];
    for (const group of [...fromPrefs, ...fromSessions]) {
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      list.push(group);
      if (list.length === 3) break;
    }
    return list;
  }, [snapshot.preferences, snapshot.projects, snapshot.threads]);

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
    setSnapshot(next);
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
          post(`/threads/${thread.providerId}/${thread.id}/archive`).then(
            () => undefined,
          ),
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
          post(`/threads/${thread.providerId}/${thread.id}/unarchive`).then(
            () => undefined,
          ),
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
          remove(`/threads/${thread.providerId}/${thread.id}`).then(
            () => undefined,
          ),
        );
        if (failed) {
          await refresh();
          pushToast(`已删除 ${ok} 个会话，${failed} 个失败，项目未移除`);
          return;
        }
        setSnapshot(await remove("/projects", { key: project.key }));
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

  const selectThread = (thread: ThreadSummary) => {
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

  const resolveApproval = async (id: string, body: ApprovalResolveBody) => {
    try {
      await post(`/approvals/${encodeURIComponent(id)}`, body);
      await refresh();
    } catch (error: any) {
      pushToast(error?.message || "审批处理失败");
    }
  };

  const openOrigin = (thread: ThreadSummary) => {
    if (!thread.forkedFromId) return;
    const source = allThreads.find((item) => item.id === thread.forkedFromId);
    if (!source) return;
    setLibrary(source.archived ? "archived" : "active");
    setSelected(sessionKey(source));
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
      <Sidebar
        show={sidebar}
        hiddenOnMobile={Boolean(current)}
        projectCount={
          mergeProjectGroups(snapshot.projects || [], snapshot.threads).length
        }
        sessionCount={snapshot.threads.length}
        archivedCount={(snapshot.archivedThreads || []).length}
        library={library}
        query={query}
        statusFilter={statusFilter}
        counts={counts}
        projects={projects}
        selected={selected}
        unseenSessions={unseenSessions}
        expandedProjects={expandedProjects}
        forkCounts={forkCounts}
        runtime={snapshot.runtime}
        notificationPermission={notificationPermission}
        archiveError={snapshot.runtime?.archiveError}
        loading={loading}
        onClose={() => setSidebar(false)}
        onNew={() => setThreadModal({})}
        onRefresh={refresh}
        onProviders={() => setProviderModal(true)}
        onUsage={() => setUsageOpen(true)}
        onNotifications={enableSystemNotifications}
        onLibrary={setLibrary}
        onQuery={setQuery}
        onStatusFilter={setStatusFilter}
        onToggleProject={(key) =>
          setExpandedProjects((currentSet) => {
            const next = new Set(currentSet);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
          })
        }
        onSelect={selectThread}
        onAddInProject={(project) =>
          setThreadModal({
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
        {!current && (
          <button
            type="button"
            className="icon-btn appearance-trigger appearance-trigger-home"
            onClick={() => setAppearanceOpen(true)}
            title="外观设置"
            aria-label="外观设置"
          >
            <Settings />
          </button>
        )}
        {!sidebar && !current && (
          <button className="floating-menu" onClick={() => setSidebar(true)}>
            <Menu />
          </button>
        )}
        {current ? (
          <RenderErrorBoundary
            resetKey={sessionKey(current)}
            fallback={
              <main className="chat">
                <header className="chat-header">
                  <div className="chat-header-row1">
                    <button
                      className="icon-btn mobile-back"
                      onClick={() => {
                        setSelected(undefined);
                        setSidebar(true);
                      }}
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
              provider={snapshot.providers.find(
                (provider) => provider.id === current.providerId,
              )}
              approvals={snapshot.approvals}
              events={events}
              origin={origin}
              onBack={() => {
                setSelected(undefined);
                setSidebar(true);
              }}
              onSnapshot={refresh}
              onSwitchProvider={() => setSwitchThread(current)}
              onMenu={() => setSheet(current)}
              onSelectThread={(providerId, threadId) => {
                const key = sessionKey({
                  agentId: current.agentId,
                  providerId,
                  id: threadId,
                });
                markSessionSeen(key);
                setSelected(key);
              }}
              onToast={pushToast}
              onUsage={() => setUsageOpen(true)}
              onAppearance={() => setAppearanceOpen(true)}
              onOpenOrigin={() => openOrigin(current)}
            />
          </RenderErrorBoundary>
        ) : (
          <Welcome
            recent={recentProjects}
            runtime={snapshot.runtime}
            loading={loading}
            onNew={() => setThreadModal({})}
            onOpenProject={(project) =>
              setThreadModal({
                cwd: project.cwd,
                project: snapshot.projects?.find(
                  (item) => item.key === project.key,
                ),
              })
            }
            onUsage={() => setUsageOpen(true)}
          />
        )}
      </section>
      {providerModal && (
        <ProviderModal
          providers={snapshot.providers}
          runtime={snapshot.runtime}
          defaultCwd={current?.cwd}
          onClose={() => setProviderModal(false)}
          onSaved={setSnapshot}
          onToast={pushToast}
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
        />
      )}
      {threadModal && (
        <NewThreadModal
          providers={snapshot.providers}
          initialCwd={threadModal.cwd}
          project={threadModal.project}
          preferences={snapshot.preferences}
          runtimeWsl={Boolean(snapshot.runtime?.runtimeWsl)}
          onClose={() => setThreadModal(null)}
          onCreated={(providerId, id) => {
            setSelected(sessionKey({ providerId, id }));
            setLibrary("active");
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
            setSelected(
              sessionKey({
                agentId: switchThread.agentId,
                providerId,
                id: threadId,
              }),
            );
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
            await api(
              `/threads/${rename.thread.providerId}/${rename.thread.id}`,
              { method: "PATCH", body: JSON.stringify({ name }) },
            );
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
          providers={snapshot.providers}
          onClose={() => setProjectEdit(null)}
          onSave={async (defaults, name) => {
            const next = await saveProject(projectEdit, { defaults, name });
            pushToast(
              next.connectionApplied
                ? "已保存，并已应用到 Runtime"
                : next.connectionPending
                  ? "已保存。有会话在跑，空闲后在供应商设置中应用"
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
              await navigator.clipboard.writeText(result.command);
              pushToast("已复制");
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
            {
              label: "重命名",
              onClick: () => setRename({ kind: "thread", thread: sheet }),
            },
            {
              label: "会话设置",
              onClick: () => setPhoneSettings(true),
            },
            {
              label: "压缩上下文",
              onClick: () =>
                post(`/threads/${sheet.providerId}/${sheet.id}/compact`).then(
                  refresh,
                ),
            },
            {
              label: "审查当前改动",
              onClick: () =>
                post(`/threads/${sheet.providerId}/${sheet.id}/review`).then(
                  refresh,
                ),
            },
            {
              label: "复制为整段分支",
              disabled:
                sheet.status === "running" || sheet.status === "waiting",
              onClick: async () => {
                const created = await post(
                  `/threads/${sheet.providerId}/${sheet.id}/fork`,
                  {},
                );
                setSelected(
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
                sheet.status === "running" || sheet.status === "waiting",
              onClick: () => setSwitchThread(sheet),
            },
            {
              label: sheet.archived ? "恢复会话" : "归档会话",
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
                    if (sheet.archived)
                      await post(
                        `/threads/${sheet.providerId}/${sheet.id}/unarchive`,
                      );
                    else
                      await post(
                        `/threads/${sheet.providerId}/${sheet.id}/archive`,
                      );
                    if (sessionKey(sheet) === selected) setSelected(undefined);
                    refresh();
                  },
                }),
            },
            {
              label: "永久删除",
              danger: true,
              onClick: () =>
                setConfirm({
                  title: "永久删除会话",
                  body: (
                    <p>
                      确定永久删除 <b>{sheet.name}</b>？此操作不可恢复。
                    </p>
                  ),
                  confirmLabel: "删除",
                  danger: true,
                  run: async () => {
                    await remove(`/threads/${sheet.providerId}/${sheet.id}`);
                    if (sessionKey(sheet) === selected) setSelected(undefined);
                    refresh();
                  },
                }),
            },
          ]}
        />
      )}
      {phoneSettings && current && (
        <Modal title="会话设置" onClose={() => setPhoneSettings(false)}>
          <div className="phone-session-settings">
            <SessionToolbar
              thread={current}
              locked={
                current.status === "running" || current.status === "waiting"
              }
              onSettings={async (settings) => {
                await api(`/threads/${current.providerId}/${current.id}`, {
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
          onRefreshLimits={refreshOfficialUsage}
          onClose={() => setUsageOpen(false)}
        />
      )}
      {appearanceOpen && (
        <AppearanceSettingsModal
          preferences={appearance.preferences}
          resolved={appearance.resolved}
          onChange={appearance.update}
          onClose={() => setAppearanceOpen(false)}
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
      <ApprovalInbox
        approvals={snapshot.approvals}
        threads={allThreads}
        notificationPermission={notificationPermission}
        onRequestNotifications={enableSystemNotifications}
        onOpenThread={openSession}
        onResolve={resolveApproval}
      />
      <ToastStack toasts={toasts} />
    </div>
  );
}
