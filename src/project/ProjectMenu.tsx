import type { ProjectGroup } from "../projects";
import { ActionSheet } from "../ui";

export function ProjectMenu({
  project,
  library,
  onPin,
  onHide,
  onRename,
  onDefaults,
  onArchive,
  onRestore,
  onDelete,
  onClose,
}: {
  project: ProjectGroup;
  library: "active" | "archived";
  onPin: () => void;
  onHide: () => void;
  onRename: () => void;
  onDefaults: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const hideDisabled = project.sessions.length > 0;
  const hasSessions = project.sessions.length > 0;
  return (
    <ActionSheet
      title={project.name}
      onClose={onClose}
      actions={[
        {
          label: project.pinned ? "取消置顶" : "置顶项目",
          onClick: onPin,
        },
        {
          label: "隐藏空项目",
          disabled: hideDisabled,
          onClick: onHide,
        },
        ...(library === "archived"
          ? [
              {
                label: `恢复项目${hasSessions ? `（${project.sessions.length}）` : ""}`,
                disabled: !hasSessions,
                onClick: onRestore,
              },
            ]
          : [
              {
                label: `归档项目${hasSessions ? `（${project.sessions.length}）` : ""}`,
                disabled: !hasSessions,
                onClick: onArchive,
              },
            ]),
        {
          label: "重命名项目",
          onClick: onRename,
        },
        {
          label: "编辑默认设置",
          onClick: onDefaults,
        },
        {
          label: "删除项目",
          danger: true,
          onClick: onDelete,
        },
      ]}
    />
  );
}
