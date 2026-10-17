export const RECENT_FILES_KEY = "codex-deck:text-editor:recent-files";
const MAX_RECENT_FILES = 10;

export function parseRecentFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (path): path is string =>
          typeof path === "string" && path.length > 0 && path.length <= 4_096,
      ),
    ),
  ].slice(0, MAX_RECENT_FILES);
}

export function rememberFile(files: string[], path: string): string[] {
  return parseRecentFiles([path, ...files]);
}

function withinPath(file: string, target: string) {
  if (file === target) return true;
  const separator = target.includes("\\") ? "\\" : "/";
  return file.startsWith(`${target.replace(/[\\/]+$/, "")}${separator}`);
}

export function forgetPath(files: string[], target: string): string[] {
  return files.filter((file) => !withinPath(file, target));
}

export function movePath(files: string[], from: string, to: string): string[] {
  return parseRecentFiles(
    files.map((file) =>
      withinPath(file, from) ? `${to}${file.slice(from.length)}` : file,
    ),
  );
}
