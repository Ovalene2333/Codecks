import { useEffect, useState } from "react";
import { Archive, Check, Copy, Radar, RotateCcw, Send, Square, Trash2, Waypoints, X } from "lucide-react";
import { api, getToken, post, remove } from "../api";
import { copyText } from "../clipboard";
import { agentShortName, threadPath } from "../agents";
import { relativeTime, sessionKey } from "../format";
import { sessionPath } from "../deck-history";
import { askStatusLabel } from "../session/AskNotice";
import { AskResult } from "./AskResult";
import { AskForm } from "./AskForm";
import type { LostWakeWatcher, ThreadSummary, WakeWatcher } from "../types";
import { Badge, Button, Group, Row, Section } from "../kit";
import { ConfirmDialog, Modal } from "../ui";


type AskItem = {
  id: string;
  alias?: string;
  sourceAgentId: string;
  sourceThreadId: string;
  targetAgentId: string;
  targetThreadId?: string;
  turnId?: string;
  targetProviderId?: string;
  returnMode: "queue" | "steer" | "interrupt";
  detached?: boolean;
  resultAvailable?: boolean;
  status: "creating" | "queued" | "running" | "answered" | "completed" | "failed" | "cancelled";
  sentCount: number;
  updatedAt: number;
  error?: string;
  cancelRequestedAt?: number;
  cancelledAt?: number;
  archivedAt?: number;
  deletedAt?: number;
};

/**
 * 远程唤醒：查看本会话的 watcher（可停止）与失联记录（可通知/忽略），
 * 所有回传均使用会话默认别名，无需单独开启。
 */
export function WakeModal({
  thread,
  watchers,
  lost,
  onClose,
  onOpenLanes,
}: {
  thread: ThreadSummary;
  /** 本机正绑定此会话代号的 watcher（来自快照缓存，可能滞后几秒）。 */
  watchers: WakeWatcher[];
  /** 此会话失联待处理的 watcher。 */
  lost: LostWakeWatcher[];
  onClose: () => void;
  /** 打开 deck-api 协作泳道示例页；不传时不显示入口。 */
  onOpenLanes?: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [localUrl, setLocalUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  /** 已点过停止/处理、等快照刷新的条目，先在界面上隐藏。 */
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [asks, setAsks] = useState<AskItem[]>([]);
  const [asksError, setAsksError] = useState("");
  const [asksVersion, setAsksVersion] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<AskItem | null>(null);
  const storageKey = `deck:wake-hidden:v1:${sessionKey(thread)}`;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []);
    } catch {
      return new Set();
    }
  });
  const saveHidden = (next: ReadonlySet<string>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      setError("无法保存隐藏记录，刷新后可能重新显示");
    }
    setHidden(next);
  };
  const hide = (key: string) => saveHidden(new Set([...hidden, key]));
  const watcherKey = (item: WakeWatcher) => `watcher:${item.pid}:${item.startedAt}`;

  useEffect(() => {
    let cancelled = false;
    const sourceAgent = thread.agentId || "codex";
    const load = async () => {
      try {
        const { items } = await api<{ items: AskItem[] }>("/deck/sessions");
        if (cancelled) return;
        setAsks(items.filter((item) =>
          item.sourceAgentId === sourceAgent && item.sourceThreadId === thread.id
        ).sort((left, right) => right.updatedAt - left.updatedAt));
        setAsksError("");
      } catch (error: any) {
        if (!cancelled) setAsksError(error.message || "询问记录读取失败");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [thread.id, thread.agentId, asksVersion]);

  useEffect(() => {
    let cancelled = false;
    api<{ alias: string; localUrl: string }>(
      `${threadPath(thread)}/wake`,
    )
      .then((data) => {
        if (cancelled) return;
        setCode(data.alias);
        setLocalUrl(data.localUrl || "");
      })
      .catch((err: any) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [thread.id]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err: any) {
      setError(err.message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const markHandled = (key: string) =>
    setHandled((current) => new Set([...current, key]));

  const stopWatcher = (watcher: WakeWatcher) =>
    run(async () => {
      await post(`/monitor/watchers/${watcher.pid}/stop`);
      markHandled(`pid:${watcher.pid}`);
    });

  const notifyLost = (item: LostWakeWatcher) =>
    run(async () => {
      await post(`/monitor/lost-watchers/${item.id}/notify`);
      markHandled(`lost:${item.id}`);
    });

  const dismissLost = (item: LostWakeWatcher) =>
    run(async () => {
      await remove(`/monitor/lost-watchers/${item.id}`);
      markHandled(`lost:${item.id}`);
    });

  const stopAsk = (item: AskItem) =>
    run(async () => {
      await post(`/deck/sessions/${item.alias || item.id}/stop`, { mode: "now" });
      setAsksVersion((value) => value + 1);
    });

  const archiveAsk = (item: AskItem) =>
    run(async () => {
      await post(`/deck/sessions/${item.alias || item.id}/${item.archivedAt ? "unarchive" : "archive"}`);
      setAsksVersion((value) => value + 1);
    });

  const deleteAsk = (item: AskItem) =>
    run(async () => {
      await remove(`/deck/sessions/${item.alias || item.id}`, { force: true });
      setPendingDelete(null);
      setAsksVersion((value) => value + 1);
    });

  const url = localUrl || (code ? `${window.location.origin}/api/deck/events/${code}` : "");
  const curl = code
    ? `curl -X POST "${url}"${getToken() ? ` -H "Authorization: Bearer ${getToken()}"` : ""} -H "Content-Type: application/json" -d '{"text":"任务已完成"}'`
    : "";

  const copyCurl = async () => {
    if (await copyText(curl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  const liveWatchers = watchers.filter((item) => !handled.has(`pid:${item.pid}`) && !hidden.has(watcherKey(item)));
  const openLost = lost.filter((item) => !handled.has(`lost:${item.id}`));

  const visibleAsks = asks.filter((item) => !item.deletedAt && !hidden.has(`ask:${item.id}`));

  return (
    <>
    <Modal title="任务回传" className="wake-modal" onClose={onClose}>
      <div className="wake-body">
        {!thread.ask && (
          <AskForm
            thread={thread}
            onCreated={() => setAsksVersion((value) => value + 1)}
          />
        )}

        <Section
          title="会话身份"
          actions={
            <>
              {hidden.size > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => saveHidden(new Set())}
                >
                  恢复隐藏记录（{hidden.size}）
                </Button>
              )}
              {onOpenLanes && (
                <Button
                  variant="ghost"
                  size="sm"
                  title="查看协作泳道示例"
                  onClick={onOpenLanes}
                >
                  <Waypoints />
                  协作泳道
                </Button>
              )}
            </>
          }
        >
          {!loaded ? <p className="ui-section__desc">正在读取会话身份…</p> : (
            <Group>
              <Row dot="ok" title="deck-api 默认可用" desc="发送消息、查询和任务唤醒共用此别名，无需开启。"
                side={<Button variant="ghost" size="sm" title="复制会话别名" aria-label="复制会话别名" onClick={() => code && copyText(`@${code}`)}><Copy />@{code}</Button>} />
            </Group>
          )}
        </Section>

        {loaded && (code || liveWatchers.length + openLost.length > 0) && (
          <Section
            title={
              <>
                监督进程
                <span className="wake-count">
                  {liveWatchers.length + openLost.length}
                </span>
              </>
            }
          >
            {liveWatchers.length + openLost.length ? (
              <Group>
                {openLost.map((item) => (
                  <Row
                    key={item.id}
                    dot="error"
                    title={`监督进程失联：${item.label}`}
                    desc={item.reason}
                    descTitle={item.reason}
                    side={
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="通知会话：发一条唤醒说明监督进程已失联"
                          aria-label={`通知会话 ${item.label} 已失联`}
                          busy={busy}
                          onClick={() => notifyLost(item)}
                        >
                          <Send />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="忽略"
                          aria-label={`忽略 ${item.label} 的失联记录`}
                          busy={busy}
                          onClick={() => dismissLost(item)}
                        >
                          <X />
                        </Button>
                      </>
                    }
                  />
                ))}
                {liveWatchers.map((item) => (
                  <Row
                    key={item.pid}
                    dot={item.failures ? "warn" : "ok"}
                    title={`监督中：${item.label}`}
                    desc={`进程号 ${item.pid}${
                      item.state ? `，${item.state}` : ""
                    }${
                      item.failures ? `，连接失败 ${item.failures}/10` : ""
                    }`}
                    descTitle={`$ ${item.command}`}
                    side={
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="停止这个监督进程（不会再唤醒会话）"
                          aria-label={`停止监督进程 ${item.label}`}
                          busy={busy}
                          onClick={() => stopWatcher(item)}
                        >
                          <Square />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="隐藏记录（进程继续运行）"
                          aria-label={`隐藏监督进程 ${item.label} 的记录`}
                          onClick={() => hide(watcherKey(item))}
                        >
                          <X />
                        </Button>
                      </>
                    }
                  />
                ))}
              </Group>
            ) : (
              <p className="wake-empty" role="status">
                <Radar aria-hidden="true" />
                暂无监督进程
              </p>
            )}
          </Section>
        )}

        {loaded && code && (
          <Section
            title="外部脚本"
            desc="外部脚本也可向此端点 POST 消息。"
          >
            <Group pad>
              <div className="wake-endpoint">
                <Badge>POST</Badge>
                <code title={url}>{url}</code>
              </div>
              <div className="wake-snippet">
                <div className="wake-snippet__head">
                  <span>调用示例</span>
                  <Button variant="ghost" size="sm" onClick={copyCurl}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? "已复制" : "复制 curl 命令"}
                  </Button>
                </div>
                <pre>{curl}</pre>
              </div>
            </Group>
          </Section>
        )}

        {visibleAsks.length > 0 && (
          <Section
            title={
              <>
                我发起的询问
                <span className="wake-count">{visibleAsks.length}</span>
              </>
            }
          >
            <Group>
              {visibleAsks.map((item) => {
                const target = item.targetThreadId
                  ? sessionKey({
                      agentId: item.targetAgentId,
                      providerId: item.targetProviderId || "",
                      id: item.targetThreadId,
                    })
                  : "";
                const noReply =
                  !item.detached &&
                  item.status === "completed" &&
                  !item.sentCount;
                const active = ["creating", "queued", "running"].includes(item.status);
                const finished = !active && !item.archivedAt;
                return (
                  <div
                    key={item.id}
                    className={`wake-ask-item${noReply ? " is-empty" : ""}`}
                  >
                    <Row
                      title={
                        target ? (
                          <a
                            className="wake-ask-target"
                            href={sessionPath(target)}
                          >
                            <span>
                              {agentShortName(item.targetAgentId)}
                            </span>
                            <span>
                              @
                              {item.alias ||
                                item.targetThreadId!.slice(0, 8)}
                            </span>
                          </a>
                        ) : (
                          <span>{agentShortName(item.targetAgentId)}</span>
                        )
                      }
                      badges={
                        <span
                          className={`wake-ask-status is-${item.archivedAt ? "archived" : item.status}`}
                        >
                          {askStatusLabel(item)}
                        </span>
                      }
                      desc={
                        <span className="wake-ask-meta">
                          <span>累计回传 {item.sentCount} 条</span>
                          <span>
                            {item.detached
                              ? "Detached，自行读取"
                              : item.returnMode === "interrupt"
                                ? "打断回传"
                                : item.returnMode === "steer"
                                  ? "即时追加回传"
                                  : "Queue 回传"}
                          </span>
                          <span>{relativeTime(item.updatedAt)}</span>
                        </span>
                      }
                      side={
                        <>
                          {active && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              title="停止当前回合（静默，不向来源回传失败消息）"
                              aria-label={`停止询问 ${item.alias || item.id}`}
                              busy={busy}
                              onClick={() => stopAsk(item)}
                            >
                              <Square />
                            </Button>
                          )}
                          {!active && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              title={item.archivedAt ? "恢复归档" : "归档（保留会话与别名）"}
                              aria-label={`${item.archivedAt ? "恢复" : "归档"}询问 ${item.alias || item.id}`}
                              busy={busy}
                              onClick={() => archiveAsk(item)}
                            >
                              {item.archivedAt ? <RotateCcw /> : <Archive />}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            title={finished ? "删除会话与台账（不可恢复）" : "停止并删除（不可恢复）"}
                            aria-label={`删除询问 ${item.alias || item.id}`}
                            busy={busy}
                            onClick={() => setPendingDelete(item)}
                          >
                            <Trash2 />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            title="隐藏询问记录"
                            aria-label={`隐藏询问记录 ${item.targetThreadId || item.id}`}
                            onClick={() => hide(`ask:${item.id}`)}
                          >
                            <X />
                          </Button>
                        </>
                      }
                    />
                    {item.error && (
                      <p className="wake-ask-error">{item.error}</p>
                    )}
                    {item.detached && (
                      <div className="wake-ask-result">
                        <AskResult
                          key={item.turnId || item.id}
                          reference={item.alias || item.id}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </Group>
          </Section>
        )}

        {asksError && <p className="error-text">{asksError}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}


      </div>
    </Modal>
    {pendingDelete && (
      <ConfirmDialog
        title="删除询问会话"
        danger
        confirmLabel="删除"
        body={
          <>
            <p>
              将删除 <strong>@{pendingDelete.alias || pendingDelete.targetThreadId}</strong> 的原生会话与台账，
              并清理 Deck 创建且无未提交改动的 worktree。
            </p>
            <p className="ui-section__desc">
              已取消的自动回传不会再出现；删除动作不可恢复，别名会保留为墓碑。
            </p>
          </>
        }
        onConfirm={() => deleteAsk(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      />
    )}
    </>
  );
}
