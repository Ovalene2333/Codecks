import type { AskRecord } from "./ask-service.js";
import type { MessageDelivery } from "./agents/messages.js";

export type LaneKind =
  | "message"
  | "send"
  | "queue"
  | "run"
  | "success"
  | "failure"
  | "wake"
  | "query";

export interface LaneThread {
  agentId: string;
  id: string;
  name?: string;
  alias?: string;
  cwd?: string;
  status?: string;
}

export interface LaneStep {
  id: string;
  from: string;
  to: string;
  kind: LaneKind;
  title: string;
  detail: string;
  tag: string;
  at: string;
  atMs: number;
  estimated?: boolean;
}

export interface LaneScenario {
  id: string;
  title: string;
  kicker: string;
  summary: string;
  lanes: { id: string; name: string; role: string; tone: string }[];
  steps: LaneStep[];
  rules: string[];
  omitted?: number;
  meta: {
    askAlias?: string;
    askId: string;
    sourceAgentId: string;
    targetAgentId: string;
    sourceThreadId: string;
    targetThreadId: string;
    sourceAlias?: string;
    targetAlias?: string;
    status: string;
    detached: boolean;
    returnMode: string;
    createdAt: number;
    updatedAt: number;
    replies: number;
    followUps: number;
    failed: number;
  };
}

export interface LaneScenarioSet {
  version: 1;
  title: string;
  source: string;
  generatedAt: number;
  scenarios: LaneScenario[];
}

export interface LaneBuildOptions {
  limit?: number;
  maxSteps?: number;
  project?: string;
  /** 询问别名或完整 ask id。 */
  ask?: string;
  /** 会话别名、原始 thread id 或 agent:threadId。 */
  session?: string;
  /** 一个输入同时匹配询问和会话，页面搜索框使用。 */
  query?: string;
  sanitize?: boolean;
}

const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  devin: "Devin",
  acp: "ACP",
};

const agentName = (id: string) => AGENT_NAMES[id] || id;

const formatTime = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const compact = (text: string) => text.replace(/\s+/g, " ").trim();

/** 去掉 Deck 注入前缀和短链接，只留下人/Agent 真正写的内容。 */
export function stripDeckPrefixes(text: string) {
  return compact(
    text
      .replace(/\[(?:ask|send|wake|message|deck-api):[^\]]*\]\s*/gi, " ")
      .replace(/\[查看完整会话\]\([^)]*\)\s*/gi, " ")
      .replace(/\b(?:codex|claude|opencode|devin):[0-9a-zA-Z-]+\s*/g, " "),
  );
}

export function sanitizeLaneText(text: string, max = 220) {
  const value = stripDeckPrefixes(text)
    .replace(/\/\/\?\/[^\s，。；、)）"'`]+/g, "<path>")
    .replace(/\/(?:data|home|srv|mnt|opt|var|tmp)\/[^\s，。；、)）"'`]+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s，。；、)）"'`]+/g, "<path>")
    .replace(/https?:\/\/[^\s，。；、)）"'`]+/g, "<url>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, "<key>")
    .replace(/\bBearer\s+[^\s，。；]+/gi, "Bearer <token>")
    .replace(/\b(?:opencode-go|zhipuai-coding-plan|siliconflow|moonshot|openrouter|openai|anthropic)\b/gi, "<provider>")
    .replace(/<provider>\/[\w.-]+/g, "<provider>/<model>")
    .replace(/\b(?:gpt|claude|glm|qwen|deepseek|gemini|llama|phi|internvl|omni)[\w.-]*/gi, "<model>");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function laneHeadline(text: string, max = 34) {
  const value = stripDeckPrefixes(text)
    .replace(/[*_`#>]/g, "")
    .replace(/^[-—–:：\s]+/, "")
    .trim();
  const first = value.split(/[。；;\n]/).map((part) => part.trim()).find(Boolean) || value;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first || "消息";
}

const deliveryFor = (
  ask: AskRecord,
  message: NonNullable<AskRecord["sentMessages"]>[number],
  deliveries: Map<string, MessageDelivery>,
) =>
  deliveries.get(String(message.deliveryId || "")) ||
  deliveries.get(`wake:${message.deliveryId}`) ||
  deliveries.get(`ask:${ask.id}:${message.id}`) ||
  deliveries.get(message.id);

const isReplyDelivery = (
  ask: AskRecord,
  delivery: MessageDelivery,
  deliveries: Map<string, MessageDelivery>,
) =>
  (ask.sentMessages || []).some((message) => deliveryFor(ask, message, deliveries)?.id === delivery.id);

const isFollowUp = (
  ask: AskRecord,
  delivery: MessageDelivery,
  deliveries: Map<string, MessageDelivery>,
) => {
  if (!ask.targetThreadId) return false;
  if (delivery.agentId !== ask.targetAgentId || delivery.threadId !== ask.targetThreadId) return false;
  if (delivery.id === ask.deliveryId) return false;
  if (isReplyDelivery(ask, delivery, deliveries)) return false;
  return delivery.createdAt >= ask.createdAt - 5_000 && delivery.createdAt <= ask.updatedAt + 5_000;
};

const selectSteps = (steps: LaneStep[], maxSteps?: number) => {
  if (!maxSteps || steps.length <= maxSteps) return { steps, omitted: 0 };
  const keep = new Map<string, LaneStep>();
  const add = (step?: LaneStep) => {
    if (step && keep.size < maxSteps!) keep.set(step.id, step);
  };
  const lastReply = [...steps].reverse().find((step) => step.id.startsWith("reply:"));
  add(steps[0]);
  add(steps[steps.length - 1]);
  for (const kind of ["failure", "wake", "success"]) {
    for (const step of steps) if (step.kind === kind) add(step);
  }
  add(lastReply);
  const remaining = Math.max(0, maxSteps - keep.size);
  const rest = steps.filter((step) => !keep.has(step.id));
  if (remaining > 0 && rest.length) {
    const stride = Math.max(1, Math.floor(rest.length / remaining));
    for (let index = 0; index < rest.length && keep.size < maxSteps; index += stride) add(rest[index]);
  }
  const selected = steps.filter((step) => keep.has(step.id));
  return { steps: selected, omitted: steps.length - selected.length };
};

export function buildLaneScenarios(
  asks: AskRecord[],
  deliveryList: MessageDelivery[],
  threads: LaneThread[],
  options: LaneBuildOptions = {},
): LaneScenarioSet {
  const sanitize = options.sanitize === true;
  const limit = options.limit ?? 8;
  const deliveries = new Map(deliveryList.map((item) => [item.id, item]));
  const threadMap = new Map(threads.map((thread) => [`${thread.agentId}:${thread.id}`, thread]));
  const threadFor = (agentId: string, threadId?: string) =>
    threadId ? threadMap.get(`${agentId}:${threadId}`) : undefined;
  const inProject = (ask: AskRecord) => {
    if (!options.project) return true;
    const needle = options.project.toLowerCase();
    return [threadFor(ask.sourceAgentId, ask.sourceThreadId), threadFor(ask.targetAgentId, ask.targetThreadId)]
      .some((thread) => thread?.cwd?.toLowerCase().includes(needle));
  };
  const normalizeRef = (value?: string) => value?.trim().replace(/^@/, "") || "";
  const askRef = normalizeRef(options.ask);
  const sessionRef = normalizeRef(options.session);
  const queryRef = normalizeRef(options.query);
  const matchesAsk = (ask: AskRecord) =>
    !askRef || ask.alias === askRef || ask.id === askRef;
  const matchesSession = (ask: AskRecord, value: string) => {
    if (!value) return true;
    const source = threadFor(ask.sourceAgentId, ask.sourceThreadId);
    const target = threadFor(ask.targetAgentId, ask.targetThreadId);
    return [source, target].some((thread) =>
      thread
        ? thread.id === value ||
          thread.alias === value ||
          `${thread.agentId}:${thread.id}` === value
        : false,
    );
  };
  const matchesQuery = (ask: AskRecord) =>
    !queryRef ||
    ask.alias === queryRef ||
    ask.id === queryRef ||
    matchesSession(ask, queryRef);

  const prepared = asks
    .filter((ask) => ask.targetThreadId && (ask.sentMessages?.length || ask.detached || ask.status === "failed"))
    .filter(inProject)
    .filter(matchesAsk)
    .filter((ask) => matchesSession(ask, sessionRef))
    .filter(matchesQuery)
    .map((ask) => {
      const followUps = deliveryList.filter((delivery) => isFollowUp(ask, delivery, deliveries));
      const failed = followUps.filter((delivery) => delivery.status === "failed").length;
      const wake = followUps.filter((delivery) => delivery.id.startsWith("wake:")).length;
      const score =
        (ask.sentMessages?.length || 0) * 2 +
        followUps.length * 2 +
        failed * 3 +
        wake * 2 +
        (ask.detached ? 5 : 0);
      return { ask, followUps, failed, score };
    })
    .sort((left, right) => right.score - left.score || right.ask.updatedAt - left.ask.updatedAt)
    .slice(0, limit);

  const scenarios = prepared.map(({ ask, followUps, failed }): LaneScenario => {
    const sourceThread = threadFor(ask.sourceAgentId, ask.sourceThreadId);
    const targetThread = threadFor(ask.targetAgentId, ask.targetThreadId);
    const sourceAlias = sourceThread?.alias || ask.sourceThreadId.slice(0, 8);
    const targetAlias = targetThread?.alias || ask.targetAlias || ask.targetThreadId?.slice(0, 8);
    const rawSourceName = sourceThread?.name || agentName(ask.sourceAgentId);
    const rawTargetName = targetThread?.name || agentName(ask.targetAgentId);
    const sourceName = sanitize ? sanitizeLaneText(rawSourceName, 80) : rawSourceName;
    const targetName = sanitize ? sanitizeLaneText(rawTargetName, 80) : rawTargetName;
    const text = (value: string, max?: number) =>
      sanitize ? sanitizeLaneText(value, max) : stripDeckPrefixes(value).slice(0, max);
    const headline = (value: string) => sanitize ? laneHeadline(sanitizeLaneText(value, 120)) : laneHeadline(value);

    const steps: LaneStep[] = [];
    let order = 0;
    const push = (step: Omit<LaneStep, "at" | "atMs"> & { atMs: number }) => {
      steps.push({
        ...step,
        at: formatTime(step.atMs),
        atMs: step.atMs + order++ / 1000,
      });
    };

    push({
      id: `question:${ask.id}`,
      from: "source",
      to: "target",
      kind: "send",
      title: "发起询问",
      detail: text(ask.question, 220),
      tag: "create",
      atMs: ask.createdAt,
    });

    const sendFollowUps = followUps.filter((delivery) => !delivery.id.startsWith("wake:"));
    for (const delivery of [...sendFollowUps].sort((left, right) => left.createdAt - right.createdAt)) {
      push({
        id: delivery.id,
        from: "source",
        to: "target",
        kind: delivery.status === "failed" ? "failure" : "send",
        title: delivery.status === "failed" ? "来源投递失败" : "来源补充",
        detail: text(delivery.text || delivery.preview || delivery.error || "", 220),
        tag: `${delivery.mode}${delivery.status === "failed" ? " · failed" : ""}`,
        atMs: delivery.createdAt,
      });
    }
    const wakeGroups = new Map<string, MessageDelivery[]>();
    for (const delivery of followUps.filter((item) => item.id.startsWith("wake:"))) {
      const code = (delivery.text || delivery.preview || "").match(/\[wake:([^\]]+)\]/)?.[1] || "wake";
      const group = wakeGroups.get(code) || [];
      group.push(delivery);
      wakeGroups.set(code, group);
    }
    for (const [code, group] of wakeGroups) {
      const first = [...group].sort((left, right) => left.createdAt - right.createdAt)[0];
      const last = [...group].sort((left, right) => right.createdAt - left.createdAt)[0];
      const failedWake = group.some((delivery) => delivery.status === "failed");
      push({
        id: `wake:${code}`,
        from: "deck",
        to: "target",
        kind: failedWake ? "failure" : "wake",
        title: group.length > 1 ? `唤醒通知 ×${group.length}` : "唤醒通知",
        detail: `${text(last.text || last.preview || last.error || "", 200)}${group.length > 1 ? `（${formatTime(first.createdAt)} 至 ${formatTime(last.createdAt)} 共 ${group.length} 条，代号 ${code}）` : ""}`,
        tag: `wake:${code}${failedWake ? " · failed" : ""}`,
        atMs: first.createdAt,
      });
    }

    const replies = (ask.sentMessages || []).map((message, index) => {
      const delivery = deliveryFor(ask, message, deliveries);
      return { message, delivery, index };
    });
    for (const { message, delivery, index } of replies) {
      const last = index === replies.length - 1;
      const failedReply = delivery?.status === "failed";
      push({
        id: `reply:${message.id}`,
        from: "target",
        to: "source",
        kind: failedReply ? "failure" : last && !ask.detached && ["answered", "completed"].includes(ask.status) ? "success" : "queue",
        title: headline(message.text),
        detail: text(message.text, 220),
        tag: delivery?.mode || message.mode || "reply",
        atMs: delivery?.createdAt || ask.createdAt + index * 1_000,
        estimated: !delivery,
      });
    }

    const ended = ask.turnEndedAt || ask.updatedAt;
    push({
      id: `status:${ask.id}`,
      from: "deck",
      to: "source",
      kind: ask.status === "failed" ? "failure" : ask.detached ? "query" : "success",
      title:
        ask.status === "failed"
          ? "询问失败"
          : ask.detached
            ? "detached 完成，等待来源查询"
            : `台账收口：${ask.status}`,
      detail: ask.error
        ? text(ask.error, 220)
        : ask.detached
          ? "完成/失败不向来源推送；状态和正文由 result / tasks 主动查询。"
          : `执行回合 ${ask.executionCompletion?.status || ask.status}，本会话共回传 ${ask.sentMessages?.length || 0} 条。`,
      tag: ask.status,
      atMs: ended + 1,
    });

    const { steps: chosen, omitted } = selectSteps(steps, options.maxSteps);
    const replyCount = ask.sentMessages?.length || 0;
    const wakeCount = followUps.filter((delivery) => delivery.id.startsWith("wake:")).length;
    const start = formatTime(ask.createdAt);
    const end = formatTime(ended);
    const rules = [
      `实际记录：${replyCount} 条目标回传、${followUps.length} 条来源/唤醒补充、${failed} 条投递失败。`,
      failed > 0
        ? "有投递失败记录：202 只代表受理，关键裁定要回去核对目标现场。"
        : "所有补充消息都有对应投递记录；受理状态仍不等于目标已执行。",
      ask.detached
        ? "detached 完成/失败不推送；结果只能由 result / tasks 主动查询。"
        : `目标共回传 ${replyCount} 条；来源不主动查询时，只会看到目标 send 的内容。`,
    ];
    if (wakeCount) rules.push(`询问期间有 ${wakeCount} 条唤醒通知进入目标队列。`);

    return {
      id: ask.alias || ask.id,
      title: targetName.length > 26 ? `${targetName.slice(0, 25)}…` : targetName,
      kicker: `${agentName(ask.sourceAgentId)} → ${agentName(ask.targetAgentId)} · ${ask.returnMode}${ask.detached ? " · detached" : ""}`,
      summary: `${sourceName} 于 ${start} 发起，${end} 收口；目标共回传 ${replyCount} 条，来源/唤醒补充 ${followUps.length} 条，其中 ${failed} 条投递失败。最终状态：${ask.status}。`,
      lanes: [
        { id: "source", name: sourceName.length > 16 ? `${sourceName.slice(0, 15)}…` : sourceName, role: `${agentName(ask.sourceAgentId)} · ${sourceAlias} · 来源`, tone: "lead" },
        { id: "deck", name: "Deck", role: "消息队列 / 投递台账", tone: "service" },
        { id: "target", name: targetName.length > 16 ? `${targetName.slice(0, 15)}…` : targetName, role: `${agentName(ask.targetAgentId)} · ${targetAlias} · 目标`, tone: "worker" },
      ],
      steps: chosen,
      rules,
      omitted,
      meta: {
        askAlias: ask.alias,
        askId: sanitize ? ask.id.slice(0, 8) : ask.id,
        sourceAgentId: ask.sourceAgentId,
        targetAgentId: ask.targetAgentId,
        sourceThreadId: sanitize ? ask.sourceThreadId.slice(0, 12) : ask.sourceThreadId,
        targetThreadId: sanitize && ask.targetThreadId ? ask.targetThreadId.slice(0, 12) : ask.targetThreadId || "",
        sourceAlias,
        targetAlias,
        status: ask.status,
        detached: ask.detached === true,
        returnMode: ask.returnMode,
        createdAt: ask.createdAt,
        updatedAt: ask.updatedAt,
        replies: replyCount,
        followUps: followUps.length,
        failed,
      },
    };
  });

  return {
    version: 1,
    title: "deck-api 实际协作泳道",
    source: sanitize
      ? "从本机 Deck 台账与会话消息解析生成；路径、URL、IP 和令牌已脱敏。"
      : "从本机 Deck 台账与会话消息实时解析：询问、回传、来源补充和投递状态均来自落盘记录。",
    generatedAt: Date.now(),
    scenarios,
  };
}

type LaneThreadLike = Omit<LaneThread, "agentId"> & { agentId?: string };

export function laneThreadsFromSummary(summary: {
  threads?: LaneThreadLike[];
  archivedThreads?: LaneThreadLike[];
}): LaneThread[] {
  return [...(summary.threads || []), ...(summary.archivedThreads || [])].flatMap((thread) =>
    thread.id && thread.agentId ? [{ ...thread, agentId: thread.agentId }] : [],
  );
}
