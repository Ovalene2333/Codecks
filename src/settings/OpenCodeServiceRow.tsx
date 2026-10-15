import { RefreshCw, RotateCcw } from "lucide-react";
import type { AgentDescriptor } from "../types";
import { Button, Row, type DotTone } from "../kit";

/** 报错只露第一行，完整 stderr 收进悬停提示。 */
const firstLine = (text?: string) => (text || "").split(/\r?\n/)[0].trim();

/**
 * OpenCode 服务状态行——「重载」「重启」的常驻入口，嵌在 Agent 详情页
 * 的「运行时」Section 里（与 CLI 版本选择同段）。按钮保持行内可见，
 * 完整说明收进 tooltip；行在手机宽度下仍保持单行。重载失效实例缓存
 * 并重读配置（目录修不好会自动升级为重启），重启显式杀掉 serve 重建。
 */
export function OpenCodeServiceRow({
  agent,
  enabled,
  pending,
  busyAll,
  onReload,
  onRestart,
}: {
  agent?: AgentDescriptor;
  enabled: boolean;
  pending?: "reload" | "restart";
  /** 「重载全部」等批量动作进行中：单条操作一并禁用。 */
  busyAll?: boolean;
  onReload: () => Promise<void> | void;
  onRestart: () => Promise<void> | void;
}) {
  const online = Boolean(agent?.online);
  const starting = Boolean(agent?.starting) && !online;
  const error = (agent?.error || "").trim();
  const tone: DotTone = online
    ? "ok"
    : error
      ? "error"
      : starting
        ? "warn"
        : "off";
  const status = online ? "运行中" : starting ? "启动中…" : "未运行";
  const desc = error
    ? firstLine(error)
    : starting
      ? "正在拉起 serve…"
      : online
        ? ""
        : "点「重载」来启动。";
  const disabled = !enabled || starting || busyAll;

  return (
    <Row
      dot={tone}
      title={status}
      desc={desc}
      descTitle={error || undefined}
      side={
        <>
          <Button
            size="sm"
            busy={pending === "reload"}
            disabled={disabled}
            title={
              enabled
                ? "失效实例缓存并重读配置与供应商目录，进程不动；目录仍坏时自动升级为重启"
                : "OpenCode 未启用，启用后才能操作"
            }
            aria-label="重载 OpenCode 服务"
            onClick={() => void onReload()}
          >
            <RefreshCw
              className={pending === "reload" ? "ui-spin" : undefined}
            />
            重载
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={pending === "restart"}
            disabled={disabled}
            title={
              enabled
                ? "杀掉 opencode serve 进程重建（中断运行中的会话），重载救不回损坏的模型/供应商目录时用"
                : "OpenCode 未启用，启用后才能操作"
            }
            aria-label="重启 OpenCode 服务"
            onClick={() => void onRestart()}
          >
            <RotateCcw
              className={pending === "restart" ? "ui-spin" : undefined}
            />
            重启服务
          </Button>
        </>
      }
    />
  );
}
