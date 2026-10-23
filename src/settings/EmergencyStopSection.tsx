import { useState } from "react";
import { AlertTriangle, Hand } from "lucide-react";
import { agentName, threadForceStopPath } from "../agents";
import { post } from "../api";
import { Button, Group, Row, Section } from "../kit";
import type { Snapshot } from "../types";
import type { ConfirmFn } from "./useAgentActions";

/** 给卡在运行中/待确认、常规停止失效的会话兜底强制归位。 */
export function EmergencyStopSection({
  snapshot,
  onSaved,
  onToast,
  onConfirm,
}: {
  snapshot: Snapshot;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
  onConfirm: ConfirmFn;
}) {
  const [stopping, setStopping] = useState<string | null>(null);
  const agents = snapshot.agents;
  const busyThreads = snapshot.threads.filter(
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
  );
}
