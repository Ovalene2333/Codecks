export interface QuickCommand {
  id: string;
  name: string;
  /** 命令模板，`{参数名}` 为占位符，执行时以用户输入值（shell 转义后）替换。 */
  command: string;
  /** 固定工作目录；缺省时跟随工具页当前目录。 */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
}

export interface QuickCommandResult {
  /** 占位符展开后真正执行的命令。 */
  command: string;
  cwd: string;
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export const QUICK_COMMAND_PARAM_RE = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/** 提取命令模板里的 `{参数名}` 占位符（按出现顺序去重）。 */
export function commandParamNames(command: string): string[] {
  const names: string[] = [];
  for (const match of command.matchAll(QUICK_COMMAND_PARAM_RE))
    if (!names.includes(match[1])) names.push(match[1]);
  return names;
}
