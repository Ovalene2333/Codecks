export function isWslCwd(value: string) {
  const input = value.trim();
  return input.startsWith("/") || /^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(input);
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
