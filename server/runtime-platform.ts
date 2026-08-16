export const WSL_CODEX_SHELL_COMMAND =
  'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; ' +
  'resolved=$(command -v "$1" 2>/dev/null || true); ' +
  'case "$resolved" in ""|/mnt/*) printf >&2 "Codex Deck: Linux Codex not found in WSL: %s\\n" "$1"; exit 127;; esac; ' +
  'exec "$@"';

export const WSL_CLAUDE_SHELL_COMMAND =
  'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; ' +
  'resolved=$(command -v "$1" 2>/dev/null || true); ' +
  'case "$resolved" in ""|/mnt/*) printf >&2 "Codex Deck: Linux Claude not found in WSL: %s\\n" "$1"; exit 127;; esac; ' +
  'cd -- "$2" || exit 72; shift 2; exec "$@"';

export function shouldUseWslRuntime(
  platform: NodeJS.Platform,
  requested: boolean,
) {
  return platform === "win32" && requested;
}

export function windowsPathToWsl(value: string) {
  const input = value.trim();
  if (!input) return input;
  if (input.startsWith("/")) return input;

  const unc = input.match(/^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(?:\\(.*))?$/i);
  if (unc)
    return `/${(unc[1] || "").replace(/\\/g, "/")}`.replace(/\/$/, "") || "/";

  const drive = input.match(/^([a-z]):[\\/]*(.*)$/i);
  if (!drive) return input;
  const rest = drive[2].replace(/\\/g, "/");
  return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

export function wslPathToWindows(value: string) {
  const input = value.trim();
  const mount = input.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!mount) return input;
  const rest = (mount[2] || "").replace(/\//g, "\\");
  return rest
    ? `${mount[1].toUpperCase()}:\\${rest}`
    : `${mount[1].toUpperCase()}:\\`;
}

export function exposeEnvironmentToWsl(
  env: NodeJS.ProcessEnv,
  names: Iterable<string>,
) {
  const entries = (env.WSLENV || "").split(":").filter(Boolean);
  const existing = new Set(entries.map((entry) => entry.split("/")[0]));
  for (const name of names) {
    if (env[name] !== undefined && !existing.has(name)) {
      entries.push(name);
      existing.add(name);
    }
  }
  return { ...env, WSLENV: entries.join(":") };
}
