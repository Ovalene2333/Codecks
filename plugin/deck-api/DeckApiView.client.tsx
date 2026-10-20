import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePlay,
  Clock3,
  Copy,
  Database,
  Eye,
  MessageSquare,
  Radar,
  RefreshCw,
  Send,
  Sparkles,
  Waypoints,
} from "lucide-react";
import { api } from "../../src/api";
import { copyText } from "../../src/clipboard";
import type { ToolViewProps } from "../client-registry";
import examples from "../../shared/deck-api-swimlane-example.json";

type LaneTone = "human" | "lead" | "service" | "worker" | "artifact";
type StepKind =
  | "message"
  | "send"
  | "queue"
  | "run"
  | "success"
  | "failure"
  | "wake"
  | "query";

interface Lane {
  id: string;
  name: string;
  role: string;
  tone: LaneTone;
}

interface Step {
  id: string;
  from: string;
  to: string;
  kind: StepKind;
  title: string;
  detail: string;
  tag: string;
  at?: string;
  estimated?: boolean;
  command?: string;
}

interface Scenario {
  id: string;
  title: string;
  kicker: string;
  summary: string;
  lanes: Lane[];
  steps: Step[];
  rules: string[];
  omitted?: number;
}

interface SwimlaneData {
  version: number;
  title: string;
  source: string;
  generatedAt?: number;
  scenarios: Scenario[];
}

const snapshot = examples as unknown as SwimlaneData;

const KIND_META: Record<
  StepKind,
  { label: string; Icon: typeof MessageSquare }
> = {
  message: { label: "消息", Icon: MessageSquare },
  send: { label: "发送", Icon: Send },
  queue: { label: "排队 / 受理", Icon: Clock3 },
  run: { label: "执行", Icon: CirclePlay },
  success: { label: "成功", Icon: Check },
  failure: { label: "失败 / 落空", Icon: CircleAlert },
  wake: { label: "唤醒", Icon: Radar },
  query: { label: "查询 / 核对", Icon: Eye },
};

const KIND_ORDER: StepKind[] = [
  "message",
  "send",
  "queue",
  "run",
  "success",
  "failure",
  "wake",
  "query",
];

export function DeckApiView({ onToast }: ToolViewProps) {
  const [data, setData] = useState<SwimlaneData>(snapshot);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [scenarioId, setScenarioId] = useState(snapshot.scenarios[0]?.id || "");
  const scenario = useMemo(
    () => data.scenarios.find((item) => item.id === scenarioId) || data.scenarios[0],
    [data, scenarioId],
  );
  const [stepId, setStepId] = useState(scenario?.steps[0]?.id || "");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<SwimlaneData>("/deck/lanes?limit=8");
      if (result.scenarios?.length) {
        setData(result);
        setLive(true);
        setLoadError("");
      } else {
        setData(snapshot);
        setLive(false);
        setLoadError("本机台账暂无可用询问，当前显示脱敏快照。");
      }
    } catch (error: any) {
      setData(snapshot);
      setLive(false);
      setLoadError(error?.message || "本机台账读取失败，当前显示脱敏快照。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!scenario) return;
    setStepId(scenario.steps[0]?.id || "");
  }, [scenario]);

  const laneIndex = useMemo(
    () => new Map(scenario?.lanes.map((lane, index) => [lane.id, index]) || []),
    [scenario],
  );
  const laneById = useMemo(
    () => new Map(scenario?.lanes.map((lane) => [lane.id, lane]) || []),
    [scenario],
  );
  const selectedIndex = scenario?.steps.findIndex((step) => step.id === stepId) ?? -1;
  const selected = selectedIndex >= 0 ? scenario.steps[selectedIndex] : undefined;

  const copy = async (command: string) => {
    if (await copyText(command)) onToast("命令已复制");
    else onToast("复制失败，请手动选择");
  };

  const move = (delta: number) => {
    if (!scenario) return;
    const next = scenario.steps[selectedIndex + delta];
    if (next) setStepId(next.id);
  };

  if (!scenario) {
    return (
      <div className="deck-api-lanes">
        <p className="lane-empty">本机台账里还没有可解析的询问记录。</p>
      </div>
    );
  }

  return (
    <div className="deck-api-lanes">
      <header className="lanes-intro">
        <div>
          <p className="lanes-eyebrow">
            <Waypoints aria-hidden="true" />
            多 Agent 协作
          </p>
          <h2>{data.title}</h2>
          <div className="lanes-source-row">
            <span className={`lanes-mode ${live ? "is-live" : "is-snapshot"}`}>
              {live ? "本机会话解析" : "脱敏快照"}
            </span>
            <p>{loadError || data.source}</p>
            <button
              type="button"
              className={`icon-btn lanes-refresh${loading ? " refreshing" : ""}`}
              title="重新解析本机台账"
              aria-label="重新解析本机台账"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw />
            </button>
          </div>
        </div>
        <div className="lanes-legend" aria-label="事件类型图例">
          {KIND_ORDER.map((kind) => {
            const { label, Icon } = KIND_META[kind];
            return (
              <span key={kind} className={`lanes-legend-item kind-${kind}`}>
                <Icon aria-hidden="true" />
                {label}
              </span>
            );
          })}
        </div>
      </header>

      <nav className="lane-tabs" role="tablist" aria-label="协作场景">
        {data.scenarios.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === scenario.id}
            className={item.id === scenario.id ? "on" : ""}
            onClick={() => setScenarioId(item.id)}
          >
            <b>{item.title}</b>
            <small>{item.kicker}</small>
          </button>
        ))}
      </nav>

      <section className="lane-scenario" role="tabpanel">
        <p className="lane-summary">
          {scenario.summary}
          {scenario.omitted ? (
            <span className="lane-omitted">中间省略 {scenario.omitted} 条，切到本机会话解析可看完整记录。</span>
          ) : null}
        </p>

        <div className="lane-board-scroll">
          <div
            className="lane-board"
            style={{
              gridTemplateColumns: `180px repeat(${scenario.steps.length}, minmax(168px, 1fr))`,
              gridTemplateRows: `38px repeat(${scenario.lanes.length}, 116px)`,
            }}
          >
            <div className="lane-axis-corner" aria-hidden="true" />
            {scenario.steps.map((step, index) => (
              <div
                className="lane-axis-tick"
                key={step.id}
                style={{ gridColumn: index + 2, gridRow: 1 }}
              >
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span>{step.at || step.tag}</span>
              </div>
            ))}

            {scenario.steps.map((step, index) => (
              <div
                key={`rail-${step.id}`}
                className="lane-rail"
                aria-hidden="true"
                style={{
                  gridColumn: index + 2,
                  gridRow: `2 / ${scenario.lanes.length + 2}`,
                }}
              />
            ))}

            {scenario.lanes.map((lane, index) => (
              <div
                key={lane.id}
                className={`lane-label tone-${lane.tone}`}
                style={{ gridColumn: 1, gridRow: index + 2 }}
              >
                <span>{lane.name}</span>
                <small>{lane.role}</small>
              </div>
            ))}

            {scenario.steps.map((step, index) => {
              const from = laneIndex.get(step.from) ?? 0;
              const to = laneIndex.get(step.to) ?? from;
              const direction = to > from ? "down" : to < from ? "up" : "flat";
              const { Icon } = KIND_META[step.kind];
              return (
                <button
                  key={step.id}
                  type="button"
                  className={`lane-step kind-${step.kind} dir-${direction}${step.id === selected?.id ? " on" : ""}`}
                  style={{
                    gridColumn: index + 2,
                    gridRow: `${from + 2} / ${from + 3}`,
                  }}
                  title={step.detail}
                  onClick={() => setStepId(step.id)}
                >
                  <span className="lane-step-head">
                    <i>
                      <Icon aria-hidden="true" />
                    </i>
                    <em>{step.tag}</em>
                  </span>
                  <strong>{step.title}</strong>
                  {direction !== "flat" ? (
                    <span className="lane-step-target">
                      {direction === "down" ? (
                        <ArrowDown aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )}
                      {laneById.get(step.to)?.name}
                    </span>
                  ) : (
                    <span className="lane-step-target is-self">本会话内</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <ol className="lane-mobile-list" aria-label="协作步骤">
          {scenario.steps.map((step, index) => {
            const { Icon } = KIND_META[step.kind];
            return (
              <li key={step.id}>
                <button
                  type="button"
                  className={`lane-mobile-step kind-${step.kind}${step.id === selected?.id ? " on" : ""}`}
                  onClick={() => setStepId(step.id)}
                >
                  <span className="lane-mobile-index">{index + 1}</span>
                  <span className="lane-mobile-body">
                    <span className="lane-mobile-route">
                      <b>{laneById.get(step.from)?.name}</b>
                      <ArrowRight aria-hidden="true" />
                      <b>{laneById.get(step.to)?.name}</b>
                      <em>
                        <Icon aria-hidden="true" />
                        {step.tag}
                      </em>
                    </span>
                    <strong>{step.title}</strong>
                    <small>{step.detail}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {selected && (
          <aside className="lane-detail" aria-live="polite">
            <div className="lane-detail-head">
              <span className={`lane-detail-kind kind-${selected.kind}`}>
                {KIND_META[selected.kind].label}
              </span>
              {selected.at && <span className="lane-detail-time">{selected.at}</span>}
              <span className="lane-detail-route">
                {laneById.get(selected.from)?.name}
                {selected.from === selected.to ? " · 本会话内" : (
                  <>
                    <ArrowRight aria-hidden="true" />
                    {laneById.get(selected.to)?.name}
                  </>
                )}
              </span>
              <span className="lane-detail-count">
                {selectedIndex + 1} / {scenario.steps.length}
              </span>
              <span className="lane-detail-nav">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="上一步"
                  title="上一步"
                  disabled={selectedIndex <= 0}
                  onClick={() => move(-1)}
                >
                  <ChevronLeft />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="下一步"
                  title="下一步"
                  disabled={selectedIndex >= scenario.steps.length - 1}
                  onClick={() => move(1)}
                >
                  <ChevronRight />
                </button>
              </span>
            </div>
            <div className="lane-detail-body">
              <div>
                <h3>{selected.title}</h3>
                <p>{selected.detail}</p>
              </div>
              {selected.command && (
                <div className="lane-command">
                  <code>{selected.command}</code>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="复制命令"
                    title="复制命令"
                    onClick={() => void copy(selected.command!)}
                  >
                    <Copy />
                  </button>
                </div>
              )}
            </div>
          </aside>
        )}

        <div className="lane-rules">
          <h3>
            <Sparkles aria-hidden="true" />
            从记录里看到
          </h3>
          <ul>
            {scenario.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="lanes-footer">
        <Database aria-hidden="true" />
        {live
          ? "数据来自本机 Deck 询问台账与消息投递记录；刷新会重新解析，不写回任何会话。"
          : "当前是脱敏快照；启动 Deck 后自动切换到本机会话解析。"}
        完整说明见 <code>docs/deck-api-examples.md</code>。
      </footer>
    </div>
  );
}
