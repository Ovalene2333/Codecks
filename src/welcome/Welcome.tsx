import { Folder, Plus } from "lucide-react";
import type { ProjectGroup } from "../projects";
import type { RuntimeSnapshot } from "../types";
import { usageChipMetric } from "../usage/format";

export function Welcome({
  recent,
  runtime,
  onNew,
  onOpenProject,
  onUsage,
}: {
  recent: ProjectGroup[];
  runtime?: RuntimeSnapshot;
  onNew: () => void;
  onOpenProject: (project: ProjectGroup) => void;
  onUsage: () => void;
}) {
  const usage = usageChipMetric(runtime?.rateLimits, runtime?.rateLimitsError);
  return (
    <div className="welcome work-entry">
      <h1>开始工作</h1>
      <p className="welcome-lead">从最近的项目继续，或新建一个会话。</p>
      <div className="recent-projects">
        {recent.map((project) => (
          <button
            type="button"
            key={project.key}
            onClick={() => onOpenProject(project)}
          >
            <Folder />
            <div>
              <b>{project.name}</b>
              <small>{project.cwd}</small>
            </div>
            <span>在此新建</span>
          </button>
        ))}
        {!recent.length && <p className="muted">还没有最近项目，先选一个目录开始。</p>}
      </div>
      <button className="primary" onClick={onNew}>
        <Plus />
        新建会话
      </button>
      <div className="system-pills">
        <span>
          {runtime?.online
            ? "Runtime 在线"
            : runtime?.starting
              ? "Runtime 启动中"
              : "Runtime 未连接"}
        </span>
        {runtime?.configPending && <span>供应商待应用</span>}
        <button type="button" className="pill-btn" onClick={onUsage}>
          Official {usage}
        </button>
      </div>
    </div>
  );
}
