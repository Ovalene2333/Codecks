import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWslDirectories } from "./fs-browse-wsl.js";

const MAX_ENTRIES = 200;
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZAB";
// 目录选择器高频往返同一路径（展开/回退/抖动），而 readdir+逐个stat 在
// 大目录下偏贵、WSL 路径还要 spawn wsl.exe（约 300-800ms）。加小容量 TTL
// 缓存：命中直接返回，3s 过期保证新建目录很快可见。
const LISTING_TTL_MS = 3_000;
const LISTING_CACHE_MAX = 100;
const listingCache = new Map<string, { expires: number; value: DirListing }>();

function readListingCache(key: string): DirListing | undefined {
  const hit = listingCache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    listingCache.delete(key);
    return undefined;
  }
  // LRU：命中上浮到末尾。
  listingCache.delete(key);
  listingCache.set(key, hit);
  return hit.value;
}

function writeListingCache(key: string, value: DirListing) {
  listingCache.delete(key);
  listingCache.set(key, { expires: Date.now() + LISTING_TTL_MS, value });
  if (listingCache.size > LISTING_CACHE_MAX) {
    const oldest = listingCache.keys().next().value;
    if (oldest !== undefined) listingCache.delete(oldest);
  }
}

export function clearDirListingCache() {
  listingCache.clear();
}

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

export function isWslFsPath(target?: string) {
  return Boolean(target?.startsWith("/"));
}

export async function listDirectories(
  target?: string,
  options: {
    useWsl?: boolean;
    listWsl?: (path: string) => Promise<DirListing>;
  } = {},
): Promise<DirListing> {
  if (options.useWsl && isWslFsPath(target)) {
    const listWsl = options.listWsl ?? listWslDirectories;
    // 自定义 listWsl 多为单测桩，不进缓存，避免桩结果污染真实缓存。
    if (options.listWsl) return listWsl(target!);
    const cacheKey = `wsl:${target}`;
    const cached = readListingCache(cacheKey);
    if (cached) return cached;
    const listing = await listWsl(target!);
    writeListingCache(cacheKey, listing);
    return listing;
  }
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
  const cacheKey = `fs:${resolved}`;
  const cached = readListingCache(cacheKey);
  if (cached) return cached;
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
  const listing: DirListing = {
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
  writeListingCache(cacheKey, listing);
  return listing;
}
