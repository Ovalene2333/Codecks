export function isWslCwd(value: string) {
  const input = value.trim();
  return input.startsWith("/") || /^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(input);
}

export function isMntDriveCwd(value: string) {
  return /^\/mnt\/[a-zA-Z](?:\/|$)/.test(toWslCwd(value));
}

export function toWslCwd(value: string) {
  const input = value.trim();
  if (!input) return input;
  if (input.startsWith("/")) return input;

  const unc = input.match(
    /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(?:\\(.*))?$/i,
  );
  if (unc)
    return `/${(unc[1] || "").replace(/\\/g, "/")}`.replace(/\/$/, "") || "/";

  const drive = input.match(/^([a-z]):[\\/]*(.*)$/i);
  if (!drive) return input;
  const rest = drive[2].replace(/\\/g, "/");
  return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

export function toWindowsCwd(value: string) {
  const posix = toWslCwd(value);
  const mount = posix.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!mount) return value.trim();
  const rest = (mount[2] || "").replace(/\//g, "\\");
  return rest ? `${mount[1].toUpperCase()}:\\${rest}` : `${mount[1].toUpperCase()}:\\`;
}

export function toggleWslCwd(value: string) {
  return isWslCwd(value) ? toWindowsCwd(value) : toWslCwd(value);
}
