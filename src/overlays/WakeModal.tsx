import { useEffect, useState } from "react";
import { Check, Copy, Radar, Send, Square, Waypoints, X } from "lucide-react";
import { api, getToken, post, remove } from "../api";
import { copyText } from "../clipboard";
import { agentShortName, threadPath } from "../agents";
import { relativeTime, sessionKey } from "../format";
import { sessionPath } from "../deck-history";
import { askStatusLabel } from "../session/AskNotice";
import { AskResult } from "./AskResult";
import { AskForm } from "./AskForm";
import type { LostWakeWatcher, ThreadSummary, WakeWatcher } from "../types";
import { Button, Field, Switch } from "../kit";
import { Modal } from "../ui";


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
  status: "creating" | "queued" | "running" | "answered" | "completed" | "failed";
  sentCount: number;
  updatedAt: number;
  error?: string;
};

/**
 * 远程唤醒：查看本会话的 watcher（可停止）与失联记录（可通知/忽略），
 * 管理唤醒代号。agent 用 deck-api wake 挂 watcher 时 Deck 会识别会话并自动
 * 分配代号，这里手动开启只在需要自定义代号或外部脚本调用时才用得上。
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
  const [preferred, setPreferred] = useState("");
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  /** 已点过停止/处理、等快照刷新的条目，先在界面上隐藏。 */
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [asks, setAsks] = useState<AskItem[]>([]);
  const [asksError, setAsksError] = useState("");
  const [asksVersion, setAsksVersion] = useState(0);
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
    api<{ code: string | null; localUrl: string | null }>(
      `${threadPath(thread)}/wake`,
    )
      .then((data) => {
        if (cancelled) return;
        setCode(data.code);
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

  const enable = () =>
    run(async () => {
      const result = await post<{
        code: string;
        localUrl: string;
        notified?: boolean;
      }>(`${threadPath(thread)}/wake`, {
        code: preferred.trim() || undefined,
        notify,
      });
      setCode(result.code);
      setLocalUrl(result.localUrl);
    });

  const disable = () =>
    run(async () => {
      await remove(`${threadPath(thread)}/wake`);
      setCode(null);
      setLocalUrl("");
    });

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

  const visibleAsks = asks.filter((item) => !hidden.has(`ask:${item.id}`));

  const supervision = (
    <>
      {openLost.length ? (
        <ul className="wake-list" aria-label="失联的监督进程">
          {openLost.map((item) => (
            <li key={item.id} className="wake-item lost">
              <Radar aria-hidden="true" />
              <span className="wake-item-text">
                <b>失联：{item.label}</b>
                <small>{item.reason}</small>
              </span>
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
            </li>
          ))}
        </ul>
      ) : null}
      {liveWatchers.length ? (
        <ul className="wake-list" aria-label="正在监督的进程">
          {liveWatchers.map((item) => (
            <li key={item.pid} className="wake-item on" title={`$ ${item.command}`}>
              <Radar aria-hidden="true" />
              <span className="wake-item-text">
                <b>监督中：{item.label}</b>
                <small>
                  进程号 {item.pid}
                  {item.state ? `，${item.state}` : ""}
                  {item.failures ? `，连接失败 ${item.failures}/10` : ""}
                </small>
              </span>
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
            </li>
          ))}
        </ul>
      ) : (
        <div className="wake-watching" role="status">
          <Radar aria-hidden="true" />
          暂无可见的监督进程
        </div>
      )}
    </>
  );

  return (
    <Modal title="任务回传" onClose={onClose}>
      {!thread.ask && <AskForm thread={thread} onCreated={() => setAsksVersion((value) => value + 1)} />}
      {hidden.size > 0 && (
        <Button variant="ghost" size="sm" onClick={() => saveHidden(new Set())}>
          恢复隐藏记录（{hidden.size}）
        </Button>
      )}
      {onOpenLanes && (
        <Button variant="ghost" size="sm" onClick={onOpenLanes}>
          <Waypoints />
          查看协作泳道示例
        </Button>
      )}
      {visibleAsks.length > 0 && (
        <section className="wake-asks" aria-label="我发起的询问">
          <div className="wake-asks-head">
            <h3>我发起的询问</h3>
            <span>{visibleAsks.length}</span>
          </div>
          <ul>
            {visibleAsks.map((item) => {
              const target = item.targetThreadId
                ? sessionKey({
                    agentId: item.targetAgentId,
                    providerId: item.targetProviderId || "",
                    id: item.targetThreadId,
                  })
                : "";
              const noReply = !item.detached && item.status === "completed" && !item.sentCount;
              const statusLabel = askStatusLabel(item);
              return (
                <li key={item.id} className={`wake-ask${noReply ? " is-empty" : ""}`}>
                  <div className="wake-ask-main">
                    {target ? (
                      <a href={sessionPath(target)}>
                        {agentShortName(item.targetAgentId)} · @{item.alias || item.targetThreadId!.slice(0, 8)}
                      </a>
                    ) : (
                      <span>{agentShortName(item.targetAgentId)}</span>
                    )}
                    <span className={`wake-ask-status is-${item.status}`}>
                      {statusLabel}
                    </span>
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
                  </div>
                  <small className="wake-ask-meta">
                    累计回传 {item.sentCount} 条 · {item.detached ? "Detached · 自行读取" : item.returnMode === "interrupt" ? "打断回传" : item.returnMode === "steer" ? "即时追加回传" : "Queue 回传"} · {relativeTime(item.updatedAt)}
                  </small>
                  {item.error && <small className="wake-ask-error">{item.error}</small>}
                  {item.detached && <AskResult key={item.turnId || item.id} reference={item.alias || item.id} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {asksError && <p className="error-text">{asksError}</p>}
      {!loaded ? (
        <p className="form-hint">正在读取唤醒状态…</p>
      ) : (
        <div className="form wake-form">
          {code ? (
            <>
              <div className="wake-head">
                <span className="wake-state">
                  <i aria-hidden="true" />
                  已开启
                </span>
                <code className="wake-code">{code}</code>
              </div>
              {supervision}
              <p className="form-hint">
                agent 用 deck-api wake 会自动用上这个代号；外部脚本可 POST
                以下端点注入消息。
              </p>
              <div className="wake-endpoint">
                <span>POST</span>
                <code>{url}</code>
              </div>
              <small className="wake-caption">调用示例</small>
              <pre className="wake-curl">{curl}</pre>
              {error && <p className="error-text">{error}</p>}
              <div className="wake-actions">
                <Button onClick={copyCurl}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "已复制" : "复制 curl 命令"}
                </Button>
                <Button variant="danger" busy={busy} onClick={disable}>
                  关闭唤醒（回收代号）
                </Button>
              </div>
            </>
          ) : (
            <>
              {supervision}
              <p className="form-hint">
                无需手动开启：agent 用 deck-api wake 会自动分配代号；只有自定义
                代号或让外部脚本调用
                <code> POST /api/deck/events/&lt;代号&gt; </code>
                时才需要在这里开启。
              </p>
              <Field label="自定义代号" hint="留空随机生成">
                <input
                  value={preferred}
                  placeholder="如 gpu-train"
                  onChange={(event) => setPreferred(event.target.value)}
                />
              </Field>
              <div className="wake-notify">
                <span className="wake-notify-text">
                  <b>开启时通知会话</b>
                  <small>注入一条说明消息，agent 可自助部署 watcher</small>
                </span>
                <Switch
                  checked={notify}
                  onChange={setNotify}
                  label="开启时通知会话"
                />
              </div>
              {error && <p className="error-text">{error}</p>}
              <Button variant="primary" busy={busy} onClick={enable}>
                开启唤醒
              </Button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
