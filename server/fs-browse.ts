import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES = 200;
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZAB";

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirEntry[];
}

export async function listDirectories(target?: string): Promise<DirListing> {
  const home = os.homedir();
  if (!target) {
    if (process.platform === "win32") return listWindowsRoots(home);
    return readDir("/", home);
  }
  return readDir(target, home);
}

async function listWindowsRoots(home: string): Promise<DirListing> {
  const entries: DirEntry[] = [];
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:\\`;
    try {
      await stat(root);
      entries.push({ name: `${letter}:`, path: root });
    } catch {}
  }
  return { path: "", parent: null, home, entries };
}

async function readDir(target: string, home: string): Promise<DirListing> {
  if (target.includes("\0")) throw new Error("非法路径");
  const resolved = path.resolve(target);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("不是目录");
  const names = await readdir(resolved, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const entry of names) {
    if (entry.name === "." || entry.name === "..") continue;
    if (entry.name.startsWith(".")) continue;
    const child = path.join(resolved, entry.name);
    try {
      if (entry.isDirectory()) entries.push({ name: entry.name, path: child });
      else if (entry.isSymbolicLink() && (await stat(child)).isDirectory())
        entries.push({ name: entry.name, path: child });
    } catch {}
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent:
      parent === resolved
        ? process.platform === "win32"
          ? ""
          : null
        : parent,
    home,
    entries,
  };
}
