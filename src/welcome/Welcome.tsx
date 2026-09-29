import { Folder, Plus } from "lucide-react";
import deckLogo from "../assets/logo.svg";
import type { ProjectGroup } from "../projects";
import type { RuntimeSnapshot } from "../types";
import { usageChipMetric } from "../usage/format";

export function Welcome({
  recent,
  runtime,
  loading,
  onNew,
  onOpenProject,
  onUsage,
}: {
  recent: ProjectGroup[];
  runtime?: RuntimeSnapshot;
  loading?: boolean;
  onNew: () => void;
  onOpenProject: (project: ProjectGroup) => void;
  onUsage: () => void;
}) {
  const usage = usageChipMetric(runtime?.rateLimits, runtime?.rateLimitsError);
  const runtimeLabel = runtime?.online
    ? "Runtime 在线"
    : runtime?.starting
      ? "Runtime 启动中"
      : "Runtime 未连接";
  return (
    <div className="welcome work-entry">
      <div className="welcome-stack">
        <img className="welcome-logo" src={deckLogo} alt="" />
        <h1>开始工作</h1>
        <p className="welcome-lead">从最近的项目继续，或新建一个会话。</p>
        <p className="welcome-status">
          <span
            className={`welcome-rt ${runtime?.online ? "on" : runtime?.starting ? "starting" : "off"}`}
          >
            {runtimeLabel}
          </span>
          {runtime?.configPending && <span>供应商待应用</span>}
          <button type="button" className="welcome-usage" onClick={onUsage}>
            Official {usage}
          </button>
        </p>
        <div className="recent-head">
          <span>最近项目</span>
          {recent.length > 0 && <em>{recent.length}</em>}
        </div>
        <div className="recent-projects">
          {recent.map((project) => (
            <button
              type="button"
              key={project.key}
              onClick={() => onOpenProject(project)}
              aria-label={`在 ${project.name} 新建会话`}
            >
              <span className="recent-icon">
                <Folder />
              </span>
              <b>{project.name}</b>
              <small>{project.cwd}</small>
              <em className="recent-count">{project.sessions.length} 会话</em>
            </button>
          ))}
          {loading && !recent.length && (
            <>
              <div className="skeleton-recent" />
              <div className="skeleton-recent" />
              <div className="skeleton-recent" />
            </>
          )}
          {!loading && !recent.length && (
            <p className="muted recent-empty">
              还没有最近项目，先选一个目录开始。
            </p>
          )}
          <button type="button" className="recent-create" onClick={onNew}>
            <span className="recent-icon">
              <Plus />
            </span>
            <b>新建会话</b>
            <small>选择目录开始</small>
          </button>
        </div>
      </div>
    </div>
  );
}
