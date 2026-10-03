import { useEffect, useState } from "react";
import { Check, Copy, Radar, Send, Square, X } from "lucide-react";
import { api, getToken, post, remove } from "../api";
import { copyText } from "../clipboard";
import { threadPath } from "../agents";
import type { LostWakeWatcher, ThreadSummary, WakeWatcher } from "../types";
import { Modal } from "../ui";

/**
 * 远程唤醒：查看本会话的 watcher（可停止）与失联记录（可通知/忽略），
 * 管理唤醒代号。agent 用 deck-wake 挂 watcher 时 Deck 会识别会话并自动
 * 分配代号，这里手动开启只在需要自定义代号或外部脚本调用时才用得上。
 */
export function WakeModal({
  thread,
  watchers,
  lost,
  onClose,
}: {
  thread: ThreadSummary;
  /** 本机正绑定此会话代号的 watcher（来自快照缓存，可能滞后几秒）。 */
  watchers: WakeWatcher[];
  /** 此会话失联待处理的 watcher。 */
  lost: LostWakeWatcher[];
  onClose: () => void;
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

  const url = localUrl || (code ? `${window.location.origin}/api/wake/${code}` : "");
  const curl = code
    ? `curl -X POST "${url}"${getToken() ? ` -H "Authorization: Bearer ${getToken()}"` : ""} -H "Content-Type: application/json" -d '{"text":"任务已完成"}'`
    : "";

  const copyCurl = async () => {
    if (await copyText(curl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  const liveWatchers = watchers.filter((item) => !handled.has(`pid:${item.pid}`));
  const openLost = lost.filter((item) => !handled.has(`lost:${item.id}`));

  const supervision = (
    <>
      {openLost.length ? (
        <ul className="wake-list" aria-label="失联的 watcher">
          {openLost.map((item) => (
            <li key={item.id} className="wake-item lost">
              <Radar aria-hidden="true" />
              <span className="wake-item-text">
                <b>失联：{item.label}</b>
                <small>{item.reason}</small>
              </span>
              <button
                type="button"
                title="通知会话：发一条唤醒说明 watcher 已失联"
                aria-label={`通知会话 ${item.label} 已失联`}
                disabled={busy}
                onClick={() => notifyLost(item)}
              >
                <Send />
              </button>
              <button
                type="button"
                title="忽略"
                aria-label={`忽略 ${item.label} 的失联记录`}
                disabled={busy}
                onClick={() => dismissLost(item)}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {liveWatchers.length ? (
        <ul className="wake-list" aria-label="监督中的 watcher">
          {liveWatchers.map((item) => (
            <li key={item.pid} className="wake-item on" title={`$ ${item.command}`}>
              <Radar aria-hidden="true" />
              <span className="wake-item-text">
                <b>监督中：{item.label}</b>
                <small>
                  pid {item.pid}
                  {item.state ? ` · ${item.state}` : ""}
                  {item.failures ? ` · 连接失败 ${item.failures}/10` : ""}
                </small>
              </span>
              <button
                type="button"
                title="停止这个 watcher（不会再唤醒会话）"
                aria-label={`停止 watcher ${item.label}`}
                disabled={busy}
                onClick={() => stopWatcher(item)}
              >
                <Square />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="wake-watching" role="status">
          <Radar aria-hidden="true" />
          本机暂无 watcher 监督此会话
        </div>
      )}
    </>
  );

  return (
    <Modal title="远程唤醒" onClose={onClose}>
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
                agent 用 deck-wake 挂 watcher 时会自动用上这个代号；外部脚本
                POST 以下端点也能向本会话注入一条消息。
              </p>
              <div className="wake-endpoint">
                <span>POST</span>
                <code>{url}</code>
              </div>
              <small className="wake-caption">调用示例</small>
              <pre className="wake-curl">{curl}</pre>
              {error && <p className="error-text">{error}</p>}
              <div className="wake-actions">
                <button type="button" onClick={copyCurl}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "已复制" : "复制 curl 命令"}
                </button>
                <button
                  type="button"
                  className="danger-btn"
                  disabled={busy}
                  onClick={disable}
                >
                  关闭唤醒（回收代号）
                </button>
              </div>
            </>
          ) : (
            <>
              {supervision}
              <p className="form-hint">
                无需手动开启：agent 用 deck-wake 挂 watcher 时，Deck 会识别发起命令的会话并自动分配代号。
                只有想自定义代号、或让外部脚本调用
                <code> POST /api/wake/&lt;代号&gt; </code>
                时才需要在这里开启。
              </p>
              <label>
                自定义代号（留空随机生成）
                <input
                  value={preferred}
                  placeholder="如 gpu-train"
                  onChange={(event) => setPreferred(event.target.value)}
                />
              </label>
              <label className="wake-notify">
                <span className="wake-notify-text">
                  <b>开启时通知会话</b>
                  <small>注入一条说明消息，agent 可自助部署 watcher</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={notify}
                    onChange={(event) => setNotify(event.target.checked)}
                  />
                  <i aria-hidden="true" />
                </span>
              </label>
              {error && <p className="error-text">{error}</p>}
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={enable}
              >
                开启唤醒
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
