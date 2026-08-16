import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CircleStop,
  Clock3,
  Cpu,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import { api, post } from "../api";
import { threadActionPath } from "../agents";
import { basename } from "../format";
import type { ActiveTask, ThreadSummary } from "../types";
import { ConfirmDialog, Drawer } from "../ui";

function elapsed(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function memory(rssKb?: number | null) {
  if (rssKb == null) return "";
  if (rssKb < 1_024) return `${rssKb} KB`;
  return `${(rssKb / 1_024).toFixed(rssKb < 10_240 ? 1 : 0)} MB`;
}

export function TaskCenter({
  scopeThreadId,
  statusVersion,
  onOpenThread,
  onToast,
  onClose,
}: {
  scopeThreadId?: string;
  statusVersion: string;
  onOpenThread: (agentId: "codex" | "claude", threadId: string) => void;
  onToast: (message: string) => void;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const [filter, setFilter] = useState<"all" | "running" | "waiting">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState<
    | { kind: "turn"; task: ActiveTask }
    | { kind: "process"; task: ActiveTask; processId: string; command: string }
  >();

  const load = useCallback(async () => {
    try {
      const result = await api<{ tasks: ActiveTask[] }>("/tasks");
      setTasks(result.tasks);
      setError("");
    } catch (loadError: any) {
      setError(loadError?.message || "任务读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, statusVersion]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const scoped = useMemo(
    () =>
      tasks.filter((task) => !scopeThreadId || task.threadId === scopeThreadId),
    [scopeThreadId, tasks],
  );
  const visible = scoped.filter(
    (task) => filter === "all" || task.status === filter,
  );
  const counts = {
    all: scoped.length,
    running: scoped.filter((task) => task.status === "running").length,
    waiting: scoped.filter((task) => task.status === "waiting").length,
  };

  const interrupt = async (task: ActiveTask) => {
    if (!task.turnId) throw new Error("这个任务缺少可中断的 Turn ID");
    await post(
      threadActionPath(
        { id: task.threadId, agentId: task.agentId } as ThreadSummary,
        "interrupt",
      ),
      { turnId: task.turnId },
    );
    onToast("已发送停止任务请求");
    await load();
  };

  const terminate = async (task: ActiveTask, processId: string) => {
    await post(
      `/agents/${task.agentId}/threads/${encodeURIComponent(task.threadId)}/background-terminals/${encodeURIComponent(processId)}/terminate`,
    );
    onToast("后台终端已停止");
    await load();
  };

  return (
    <>
      <Drawer
        title={scopeThreadId ? "此 Session 的任务" : "任务中心"}
        className="task-drawer"
        onClose={onClose}
      >
        <div className="task-center-head">
          <div className="task-filters" role="tablist" aria-label="任务状态">
            {(["all", "running", "waiting"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                className={filter === value ? "on" : ""}
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "all"
                  ? "全部"
                  : value === "running"
                    ? "运行"
                    : "待确认"}
                <em>{counts[value]}</em>
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`icon-btn task-refresh ${loading ? "refreshing" : ""}`}
            onClick={() => void load()}
            title="刷新任务"
          >
            <RefreshCw />
          </button>
        </div>
        {error && <p className="error-banner">{error}</p>}
        <div className="task-list" aria-busy={loading}>
          {!loading && !visible.length && (
            <div className="task-empty">
              <Activity />
              <b>没有匹配的活动任务</b>
              <small>
                {scopeThreadId
                  ? "此 Session 当前空闲"
                  : "所有受管 Session 当前空闲"}
              </small>
            </div>
          )}
          {visible.map((task) => (
            <section className="task-row" key={task.id}>
              <header>
                <div className={`task-state ${task.status}`}>
                  <i />
                  {task.status === "waiting" ? "待确认" : "运行中"}
                </div>
                <span>
                  <Clock3 />
                  {elapsed(task.startedAt, now)}
                </span>
              </header>
              <button
                type="button"
                className="task-session-link"
                onClick={() => onOpenThread(task.agentId, task.threadId)}
              >
                <div>
                  <strong>{task.threadName}</strong>
                  <small>
                    {basename(task.cwd)} · {task.model}
                  </small>
                </div>
                <ArrowUpRight />
              </button>
              {task.commands.length ? (
                <div className="task-command-list">
                  {task.commands.map((command, index) => (
                    <div
                      className="task-command-row"
                      key={
                        command.processId ||
                        command.itemId ||
                        `${command.command}-${index}`
                      }
                    >
                      <SquareTerminal />
                      <div>
                        <code title={command.command}>{command.command}</code>
                        <small>
                          {command.status === "background"
                            ? "后台终端"
                            : "执行中"}
                          {command.osPid != null
                            ? ` · PID ${command.osPid}`
                            : ""}
                          {command.cpuPercent != null
                            ? ` · CPU ${command.cpuPercent.toFixed(1)}%`
                            : ""}
                          {memory(command.rssKb)
                            ? ` · ${memory(command.rssKb)}`
                            : ""}
                        </small>
                      </div>
                      {command.status === "background" &&
                      command.processId &&
                      task.processControl ? (
                        <button
                          type="button"
                          className="icon-btn process-stop"
                          onClick={() =>
                            setConfirm({
                              kind: "process",
                              task,
                              processId: command.processId!,
                              command: command.command,
                            })
                          }
                          title="停止此后台终端"
                        >
                          <CircleStop />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="task-phase">
                  <Cpu />
                  {task.status === "waiting"
                    ? "等待用户确认"
                    : "Agent 正在处理当前 Turn"}
                </p>
              )}
              {task.detailError && (
                <small className="task-detail-error">{task.detailError}</small>
              )}
              <button
                type="button"
                className="task-stop-turn"
                disabled={!task.turnId}
                onClick={() => setConfirm({ kind: "turn", task })}
              >
                <CircleStop />
                停止整个任务
              </button>
            </section>
          ))}
        </div>
      </Drawer>
      {confirm && (
        <div className="task-confirm-layer">
          <ConfirmDialog
            title={confirm.kind === "process" ? "停止后台终端" : "停止整个任务"}
            body={
              <p>
                {confirm.kind === "process" ? (
                  <>
                    确定停止 <b>{confirm.command}</b>？当前 Turn 会继续运行。
                  </>
                ) : (
                  <>
                    确定中断 <b>{confirm.task.threadName}</b> 的当前 Turn？
                  </>
                )}
              </p>
            }
            confirmLabel="停止"
            danger
            onClose={() => setConfirm(undefined)}
            onConfirm={() => {
              const current = confirm;
              setConfirm(undefined);
              void (
                current.kind === "process"
                  ? terminate(current.task, current.processId)
                  : interrupt(current.task)
              ).catch((actionError) => onToast(actionError.message));
            }}
          />
        </div>
      )}
    </>
  );
}
