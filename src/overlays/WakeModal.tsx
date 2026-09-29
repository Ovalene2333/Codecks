import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, getToken, post, remove } from "../api";
import { copyText } from "../clipboard";
import { threadPath } from "../agents";
import type { ThreadSummary } from "../types";
import { Modal } from "../ui";

/**
 * 远程唤醒开关：为会话分配/回收唤醒代号。
 * 开启后可选择把端点与代号注入会话上下文，agent 可自行在远端部署 watcher。
 */
export function WakeModal({
  thread,
  onClose,
}: {
  thread: ThreadSummary;
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
              <p className="form-hint">
                在本机跑一个 watcher 盯远端任务，结束时 POST
                以下端点，即可向本会话注入一条消息。
              </p>
              <div className="wake-endpoint">
                <span>POST</span>
                <code>{url}</code>
              </div>
              <small className="wake-caption">调用示例</small>
              <pre className="wake-curl">{curl}</pre>
              <p className="form-hint">
                未通知会话时，直接告诉 agent「用 deck-wake，代号 {code}」即可。
              </p>
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
              <p className="form-hint">
                开启后分配一个唤醒代号，本机 watcher 脚本调用
                <code> POST /api/wake/&lt;代号&gt; </code>
                即可唤醒本会话。
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
