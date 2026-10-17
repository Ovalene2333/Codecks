import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  Hand,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { agentName, threadForceStopPath } from "../agents";
import { getToken, post, put } from "../api";
import { normalizeAppearancePreferences } from "../appearance";
import { localCacheUsage, requestLocalCacheClear } from "../cache";
import {
  getDeckSettings,
  normalizeDeckSettings,
  resetDeckSettings,
  updateDeckSettings,
} from "../deck-settings";
import { Button, Group, Row, Section } from "../kit";
import type { DeckPreferences, Snapshot } from "../types";
import type { AppearanceControl } from "./InterfacePage";
import type { ConfirmFn } from "./useAgentActions";

/** 可导出/导入的服务端偏好：只含新会话默认值，不含最近目录与 Runtime 连接参数。 */
const SERVER_KEYS = [
  "pinDefaults",
  "lastAgentId",
  "lastProviderId",
  "lastModel",
  "lastReasoningEffort",
  "lastSandbox",
  "lastApprovalPolicy",
  "lastApprovalsReviewer",
  "lastPermissionMode",
] as const;

const TOKEN_KEY = "codex-deck-token";

interface SettingsExport {
  app: "codex-deck";
  kind: "settings";
  version: 1;
  exportedAt: string;
  device: { appearance: unknown; settings: unknown };
  server: Partial<DeckPreferences>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pickServerPrefs(input: unknown): Partial<DeckPreferences> {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SERVER_KEYS)
    if (source[key] !== undefined && source[key] !== null)
      out[key] = source[key];
  return out as Partial<DeckPreferences>;
}

/** 数据：设置的导出/导入、本地缓存、最近目录、恢复默认、本机令牌。 */
export function DataPage({
  snapshot,
  preferences,
  appearance,
  onSaved,
  onToast,
  onConfirm,
}: {
  snapshot?: Snapshot;
  preferences?: DeckPreferences;
  appearance: AppearanceControl;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirm: ConfirmFn;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const usage = useMemo(localCacheUsage, []);
  const recentCount = preferences?.recentDirs?.length || 0;
  const hasToken = Boolean(getToken());
  const [stopping, setStopping] = useState<string | null>(null);
  const agents = snapshot?.agents;
  const busyThreads = (snapshot?.threads || []).filter(
    (thread) => thread.status === "running" || thread.status === "waiting",
  );
  const busyNote = busyThreads.length
    ? busyThreads
        .map((thread) => `${agentName(agents, thread)}「${thread.name}」`)
        .join("、")
    : "没有运行中或等待确认的会话";
  const stopOne = async (thread: Snapshot["threads"][number]) => {
    setStopping(thread.id);
    try {
      const result = await post<{ snapshot: Snapshot }>(
        threadForceStopPath(thread),
      );
      if (result.snapshot) onSaved(result.snapshot);
      return null;
    } catch (error: any) {
      return String(error?.message || error || "紧急停止失败");
    } finally {
      setStopping(null);
    }
  };

  const exportSettings = () => {
    const payload: SettingsExport = {
      app: "codex-deck",
      kind: "settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      device: {
        appearance: appearance.preferences,
        settings: getDeckSettings(),
      },
      server: pickServerPrefs(preferences),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `codex-deck-settings-${payload.exportedAt.slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    onToast("已导出设置");
  };

  const importFile = async (file: File) => {
    let parsed: SettingsExport;
    try {
      parsed = JSON.parse(await file.text());
      if (parsed?.app !== "codex-deck" || parsed?.kind !== "settings")
        throw new Error("不是 Codex Deck 导出的设置文件");
    } catch (err: any) {
      onToast(
        err instanceof SyntaxError ? "文件不是有效的 JSON" : err.message,
      );
      return;
    }
    const server = pickServerPrefs(parsed.server);
    onConfirm(
      {
        title: "导入设置？",
        body: (
          <p>
            会覆盖本设备的外观、输入、提醒、工具偏好
            {Object.keys(server).length ? "，以及服务端的新会话默认值" : ""}。
            导出时间：{parsed.exportedAt?.slice(0, 19).replace("T", " ") || "未知"}。
          </p>
        ),
        confirmLabel: "导入",
      },
      async () => {
        if (parsed.device?.appearance)
          appearance.update(
            normalizeAppearancePreferences(parsed.device.appearance),
          );
        if (parsed.device?.settings)
          updateDeckSettings(normalizeDeckSettings(parsed.device.settings));
        if (Object.keys(server).length)
          onSaved(await put<Snapshot>("/preferences", server));
        onToast("设置已导入");
      },
    );
  };

  const clearCache = () =>
    onConfirm(
      {
        title: "清除本地缓存？",
        body: (
          <p>
            删除本浏览器缓存的会话列表与会话全文（约 {formatBytes(usage.bytes)}
            ），然后重新加载页面。服务端数据、设置与登录状态不受影响。
          </p>
        ),
        confirmLabel: "清除并重新加载",
      },
      () => {
        requestLocalCacheClear();
        location.reload();
      },
    );

  const clearRecent = () =>
    onConfirm(
      {
        title: "清空最近目录？",
        body: (
          <p>
            新建会话时的「最近目录」建议会清空；项目列表与会话历史不受影响。
          </p>
        ),
        confirmLabel: "清空",
      },
      async () => {
        onSaved(await put<Snapshot>("/preferences", { recentDirs: [] }));
        onToast("最近目录已清空");
      },
    );

  const resetDevice = () =>
    onConfirm(
      {
        title: "恢复本设备默认设置？",
        body: (
          <p>
            外观、正文字号、发送键、提醒开关与工具菜单恢复默认。服务端的新会话默认值不变。
          </p>
        ),
        confirmLabel: "恢复默认",
      },
      () => {
        appearance.update(normalizeAppearancePreferences(null));
        resetDeckSettings();
        onToast("已恢复本设备默认设置");
      },
    );

  const forgetToken = () =>
    onConfirm(
      {
        title: "在本设备退出？",
        body: (
          <p>
            删除本浏览器保存的访问令牌并重新加载；之后需要重新输入令牌或配对码才能访问。
          </p>
        ),
        confirmLabel: "退出",
        danger: true,
      },
      () => {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {
          // ignore
        }
        location.reload();
      },
    );

  const forceStop = (thread: Snapshot["threads"][number]) => {
    const label = `${agentName(agents, thread)}「${thread.name}」`;
    onConfirm(
      {
        title: `紧急停止 ${label}？`,
        body: (
          <p>
            先尽力打断该会话正在执行的任务，然后不经校验把卡住的状态强制归位空闲，并撤掉挂起的审批。会话本身保留，之后可以继续使用。
          </p>
        ),
        confirmLabel: "强制停止",
        danger: true,
      },
      async () => {
        const error = await stopOne(thread);
        onToast(error || "已紧急停止");
      },
    );
  };

  const forceStopAll = () =>
    onConfirm(
      {
        title: `紧急停止全部 ${busyThreads.length} 个会话？`,
        body: (
          <p>
            {busyNote}
            。先尽力打断每个会话正在执行的任务，然后把卡住的状态强制归位空闲。会话本身保留。
          </p>
        ),
        confirmLabel: "全部停止",
        danger: true,
      },
      async () => {
        const errors: string[] = [];
        for (const thread of busyThreads) {
          const error = await stopOne(thread);
          if (error) errors.push(`${thread.name}：${error}`);
        }
        onToast(errors.length ? errors.join("；") : "已全部紧急停止");
      },
    );

  return (
    <>
      <Section
        title="设置备份"
        desc="导出本设备偏好与新会话默认值，供更换浏览器或设备后导入。不含访问令牌与 API 密钥。"
      >
        <Group>
          <Row
            title="导出"
            desc="下载 JSON 文件"
            side={
              <Button size="sm" onClick={exportSettings}>
                <Download />
                导出
              </Button>
            }
          />
          <Row
            title="导入"
            desc="从导出的 JSON 恢复"
            side={
              <>
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload />
                  导入
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importFile(file);
                  }}
                />
              </>
            }
          />
        </Group>
      </Section>
      <Section title="存储">
        <Group>
          <Row
            title="本地缓存"
            desc={
              usage.bytes
                ? `${formatBytes(usage.bytes)}，${usage.threads} 个会话全文。用于加速首屏加载，可随时重建。`
                : "没有缓存"
            }
            side={
              <Button size="sm" disabled={!usage.bytes} onClick={clearCache}>
                清除
              </Button>
            }
          />
          <Row
            title="最近目录"
            desc={
              recentCount
                ? `${recentCount} 个，新建会话时作为建议`
                : "没有记录"
            }
            side={
              <Button size="sm" disabled={!recentCount} onClick={clearRecent}>
                清空
              </Button>
            }
          />
        </Group>
      </Section>
      <Section title="重置">
        <Group>
          <Row
            title="恢复本设备默认设置"
            desc="外观、输入、提醒、工具菜单"
            side={
              <Button size="sm" onClick={resetDevice}>
                <RotateCcw />
                恢复
              </Button>
            }
          />
          {hasToken ? (
            <Row
              title="在本设备退出"
              desc="删除本浏览器保存的访问令牌"
              side={
                <Button size="sm" variant="danger" onClick={forgetToken}>
                  <Trash2 />
                  退出
                </Button>
              }
            />
          ) : null}
        </Group>
      </Section>
      <Section
        title="紧急停止"
        desc="会话卡在「运行中 / 待确认」且常规停止、删除都失效时，在这里强制解除占用。"
      >
        <Group>
          <Row
            dot={busyThreads.length ? "busy" : "ok"}
            title={
              busyThreads.length
                ? `${busyThreads.length} 个会话正在占用`
                : "没有需要紧急停止的会话"
            }
            desc={busyNote}
          />
          {busyThreads.map((thread) => (
            <Row
              key={thread.id}
              dot={thread.status === "waiting" ? "warn" : "busy"}
              title={thread.name}
              desc={`${agentName(agents, thread)}，${
                thread.status === "waiting" ? "等待确认" : "运行中"
              }`}
              side={
                <Button
                  size="sm"
                  variant="danger"
                  busy={stopping === thread.id}
                  onClick={() => forceStop(thread)}
                >
                  <Hand />
                  强制停止
                </Button>
              }
            />
          ))}
          {busyThreads.length ? (
            <Row
              title="全部强制停止"
              desc="逐个打断并归位上面列出的所有会话"
              side={
                <Button
                  size="sm"
                  variant="danger"
                  busy={busyThreads.some((thread) => stopping === thread.id)}
                  disabled={busyThreads.some((thread) => stopping === thread.id)}
                  onClick={forceStopAll}
                >
                  <AlertTriangle />
                  全部停止
                </Button>
              }
            />
          ) : null}
        </Group>
      </Section>
    </>
  );
}
