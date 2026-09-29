export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
  mtimeMs?: number;
}

export interface FsListing {
  path: string;
  parent: string | null;
  home: string;
  entries: FsEntry[];
}

export interface FsFile {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  mtimeMs: number;
}

export type FsWriteResult =
  | { status: "saved"; path: string; size: number; mtimeMs: number }
  | { status: "conflict"; path: string; mtimeMs: number };
