import type { ComponentType } from "react";
import { GitBranch, Puzzle, Terminal } from "lucide-react";
import type { ToolDescriptor } from "./types";
import { GitView } from "./git/GitView.client";
import { TerminalView } from "./terminal/TerminalView.client";
import "./git/git.css";
import "./terminal/terminal.css";

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
};

export const toolIcon = (id: string) => plugins[id]?.icon || Puzzle;
export const toolView = (id: string) => plugins[id]?.view;

export const toolPath = (pathname: string) =>
  pathname === "/page/terminal"
    ? "/terminal"
    : Object.keys(plugins).find((id) => pathname === `/${id}`)
      ? pathname
      : undefined;
