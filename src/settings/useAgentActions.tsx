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
  const [pending, setPending] = useState<Record<string, "toggle" | "reload">>(
    {},
  );
  const [reloadingAll, setReloadingAll] = useState(false);
  const mark = (id: string, kind: "toggle" | "reload") =>
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

  const reload = async (
    agent: Pick<AgentDescriptor, "id" | "name">,
    force = false,
  ): Promise<void> => {
    mark(agent.id, "reload");
    try {
      const { result, snapshot } = await post<AgentReloadResponse>(
        `${path(agent.id)}/reload`,
        force ? { force: true } : undefined,
      );
      onSaved(snapshot);
      if (result.error)
        onToast(`${agent.name} 重载失败：${firstLine(result.error)}`);
      else if (!result.reloaded)
        onConfirm(
          {
            title: `重载 ${agent.name}？`,
            body: (
              <p>
                {agent.name} 有 <b>{result.busyCount}</b>{" "}
                个会话正在运行或等待审批，重载会中断它们。
              </p>
            ),
            confirmLabel: "仍要重载",
            danger: true,
          },
          () => reload(agent, true),
        );
      else onToast(`已重载 ${agent.name}`);
    } catch (error: any) {
      onToast(error?.message || "重载失败");
    } finally {
      unmark(agent.id);
    }
  };

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
        ...response.sync.removed.map((id) => `移除 ${id}`),
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

  return { pending, reloadingAll, toggle, reload, reloadAll };
}

export type AgentActions = ReturnType<typeof useAgentActions>;
