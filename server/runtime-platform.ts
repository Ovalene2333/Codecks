export const WSL_CODEX_SHELL_COMMAND =
  'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; ' +
  'resolved=$(command -v "$1" 2>/dev/null || true); ' +
  'case "$resolved" in ""|/mnt/*) printf >&2 "Codex Deck: Linux Codex not found in WSL: %s\\n" "$1"; exit 127;; esac; ' +
  'exec "$@"';

export function shouldUseWslRuntime(platform: NodeJS.Platform, requested: boolean) {
  return platform === "win32" && requested;
}

export function windowsPathToWsl(value: string) {
  const input = value.trim();
  if (!input) return input;
  if (input.startsWith("/")) return input;

  const unc = input.match(
    /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(?:\\(.*))?$/i,
  );
  if (unc) return `/${(unc[1] || "").replace(/\\/g, "/")}`.replace(/\/$/, "") || "/";

  const drive = input.match(/^([a-z]):[\\/]*(.*)$/i);
  if (!drive) return input;
  const rest = drive[2].replace(/\\/g, "/");
  return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
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
