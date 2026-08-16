export interface GitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitSnapshot {
  repository: boolean;
  cwd: string;
  root?: string;
  branch?: string;
  branches: string[];
  remotes: string[];
  ahead: number;
  behind: number;
  changes: GitChange[];
  message?: string;
}
