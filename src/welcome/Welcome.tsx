import { Folder, Plus } from "lucide-react";
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
        <h1>开始工作</h1>
        <p className="welcome-lead">从最近的项目继续，或新建一个会话。</p>
        <div className="recent-projects">
          {recent.map((project) => (
            <button
              type="button"
              key={project.key}
              onClick={() => onOpenProject(project)}
              aria-label={`在 ${project.name} 新建会话`}
            >
              <Folder />
              <div>
                <b>{project.name}</b>
                <small>{project.cwd}</small>
              </div>
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
            <Plus />
            新建会话
          </button>
        </div>
        <p className="welcome-status">
          <span>{runtimeLabel}</span>
          {runtime?.configPending && <span>供应商待应用</span>}
          <button type="button" className="welcome-usage" onClick={onUsage}>
            Official {usage}
          </button>
        </p>
      </div>
    </div>
  );
}
