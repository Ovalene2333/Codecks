import { useState, type ReactNode } from "react";
import { post, put } from "../api";
import type {
  AgentDescriptor,
  AgentReloadResponse,
  AgentsReloadResponse,
  AgentToggleResponse,
  Snapshot,
} from "../types";

export interface ConfirmSpec {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

export type ConfirmFn = (
  spec: ConfirmSpec,
  run: () => Promise<void> | void,
) => void;

/** 报错常带多行启动命令与 stderr，提示里只取第一行，完整内容留给悬停。 */
export const firstLine = (text?: string) =>
  (text || "").split(/\r?\n/)[0].trim();

/**
 * 设置里对 Agent 的操作：启用/停用、重载单个、重载全部。
 * 三者都不重启 Deck 主服务；有会话在运行时服务端不会执行，返回
 * busyCount，这里弹确认，确认后带 force 重发。
 */
export function useAgentActions({
  onSaved,
  onToast,
  onConfirm,
}: {
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirm: ConfirmFn;
}) {
  const [pending, setPending] = useState<
    Record<string, "toggle" | "reload" | "restart">
  >({});
  const [reloadingAll, setReloadingAll] = useState(false);
  const mark = (id: string, kind: "toggle" | "reload" | "restart") =>
    setPending((current) => ({ ...current, [id]: kind }));
  const unmark = (id: string) =>
    setPending((current) => {
      const { [id]: _done, ...rest } = current;
      return rest;
    });
  const path = (id: string) => `/agents/${encodeURIComponent(id)}`;

  const toggle = async (
    agent: AgentDescriptor,
    enabled: boolean,
    force = false,
  ): Promise<void> => {
    mark(agent.id, "toggle");
    try {
      const result = await put<AgentToggleResponse>(
        `${path(agent.id)}/enabled`,
        {
          enabled,
          ...(force ? { force: true } : {}),
        },
      );
      onSaved(result.snapshot);
      if (!result.applied) {
        onConfirm(
          {
            title: `停用 ${agent.name}？`,
            body: (
              <p>
                {agent.name} 有 <b>{result.busyCount}</b>{" "}
                个会话正在运行或等待审批，停用会中断它们。
              </p>
            ),
            confirmLabel: "仍要停用",
            danger: true,
          },
          () => toggle(agent, enabled, true),
        );
        return;
      }
      if (!enabled) {
        onToast(`已停用 ${agent.name}`);
        return;
      }
      const started = result.snapshot.agents?.find(
        (item) => item.id === agent.id,
      );
      const failure = firstLine(started?.error);
      onToast(
        failure
          ? `已启用 ${agent.name}，但启动失败：${failure}`
          : `已启用 ${agent.name}`,
      );
    } catch (error: any) {
      onToast(error?.message || "操作失败");
    } finally {
      unmark(agent.id);
    }
  };

  /**
   * 重载（reload）：让配置变动生效的轻量动作——OpenCode 走实例级 dispose
   * 重读目录，进程不动（除非服务端自检发现坏的目录，升级为重启）；
   * Codex / Claude 的重载本来就是重启进程。
   * 重启（restart）：显式杀掉后端进程重建，重载救不回目录 / 模型缓存时用。
   */
  const reload = async (
    agent: Pick<AgentDescriptor, "id" | "name">,
    options: { force?: boolean; restart?: boolean } = {},
  ): Promise<void> => {
    const { force = false, restart = false } = options;
    mark(agent.id, restart ? "restart" : "reload");
    const verb = restart ? "重启" : "重载";
    try {
      const { result, snapshot } = await post<AgentReloadResponse>(
        `${path(agent.id)}/reload`,
        force || restart ? { ...(force ? { force: true } : {}), ...(restart ? { restart: true } : {}) } : undefined,
      );
      onSaved(snapshot);
      if (result.error)
        onToast(`${agent.name} ${verb}失败：${firstLine(result.error)}`);
      else if (!result.reloaded)
        onConfirm(
          {
            title: `${verb} ${agent.name}？`,
            body: (
              <p>
                {agent.name} 有 <b>{result.busyCount}</b>{" "}
                个会话正在运行或等待审批，{verb}会中断它们。
              </p>
            ),
            confirmLabel: `仍要${verb}`,
            danger: true,
          },
          () => reload(agent, { force: true, restart }),
        );
      else if (restart || result.mode === "process")
        onToast(
          `已重启 ${agent.name} 服务（进程级缓存已丢弃，配置与会话已重新读取）`,
        );
      else onToast(`已重载 ${agent.name}（实例缓存已失效，进程未动）`);
    } catch (error: any) {
      onToast(error?.message || `${verb}失败`);
    } finally {
      unmark(agent.id);
    }
  };

  const restart = async (
    agent: Pick<AgentDescriptor, "id" | "name">,
    force = false,
  ): Promise<void> => reload(agent, { force, restart: true });

  const reloadAll = async (): Promise<void> => {
    setReloadingAll(true);
    try {
      const response = await post<AgentsReloadResponse>("/agents/reload");
      onSaved(response.snapshot);
      const names = new Map(
        (response.snapshot.agents || []).map((item) => [item.id, item.name]),
      );
      const label = (id: string) => names.get(id) || id;
      const parts = [
        `已重载 ${response.results.filter((item) => item.reloaded).length} 个 Agent`,
      ];
      const changes = [
        ...response.sync.added.map((id) => `新增 ${label(id)}`),
        ...response.sync.replaced.map((id) => `更新 ${label(id)}`),
        ...response.sync.removed.map((id) => `移除 ${label(id)}`),
      ];
      if (changes.length) parts.push(changes.join("、"));
      const busy = response.results.filter(
        (item) => !item.reloaded && !item.error,
      );
      if (busy.length)
        parts.push(
          `${busy.map((item) => label(item.id)).join("、")} 有会话在运行，已跳过`,
        );
      const failed = response.results.filter((item) => item.error);
      if (failed.length)
        parts.push(
          `${failed.map((item) => `${label(item.id)}（${firstLine(item.error)}）`).join("、")} 重载失败`,
        );
      onToast(parts.join("；"));
    } catch (error: any) {
      onToast(error?.message || "重载失败");
    } finally {
      setReloadingAll(false);
    }
  };

  return { pending, reloadingAll, toggle, reload, restart, reloadAll };
}

export type AgentActions = ReturnType<typeof useAgentActions>;
