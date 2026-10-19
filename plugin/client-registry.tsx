import { lazy, type ComponentType } from "react";
import { FilePen, GitBranch, Puzzle, Terminal, Zap } from "lucide-react";
import type { ToolDescriptor } from "./types";
import "./git/git.css";
import "./terminal/terminal.css";
import "./text-files/text-files.css";
import "./quick-command/quick-command.css";

const GitView = lazy(() =>
  import("./git/GitView.client").then((module) => ({
    default: module.GitView,
  })),
);
const TerminalView = lazy(() =>
  import("./terminal/TerminalView.client").then((module) => ({
    default: module.TerminalView,
  })),
);
const TextFilesView = lazy(() =>
  import("./text-files/TextFilesView.client").then((module) => ({
    default: module.TextFilesView,
  })),
);
const QuickCommandView = lazy(() =>
  import("./quick-command/QuickCommandView.client").then((module) => ({
    default: module.QuickCommandView,
  })),
);

export interface ToolViewProps {
  tool: ToolDescriptor;
  initialCwd?: string;
  directories: string[];
  onToast: (message: string) => void;
}

interface ClientPlugin {
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  view: ComponentType<ToolViewProps>;
}

const plugins: Record<string, ClientPlugin> = {
  terminal: { icon: Terminal, view: TerminalView },
  git: { icon: GitBranch, view: GitView },
  "text-editor": { icon: FilePen, view: TextFilesView },
  commands: { icon: Zap, view: QuickCommandView },
};

export const toolIcon = (id: string) => plugins[id]?.icon || Puzzle;
export const toolView = (id: string) => plugins[id]?.view;

/** 历史路径 → 现行路径；保持旧链接/书签可用。 */
const TOOL_ALIASES: Record<string, string> = {
  "/page/terminal": "/terminal",
  "/text-files": "/text-editor",
};

export const toolPath = (pathname: string) =>
  TOOL_ALIASES[pathname] ||
  (Object.keys(plugins).find((id) => pathname === `/${id}`)
    ? pathname
    : undefined);
