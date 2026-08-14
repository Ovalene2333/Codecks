export function normalizePublicOrigin(hostname: string): string {
  const raw = hostname.trim();
  if (!raw) throw new Error("公网域名不能为空");
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new Error(`公网域名无效：${hostname}`);
  }
  if (parsed.protocol !== "https:") throw new Error("公网隧道地址必须使用 https");
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1") {
    throw new Error("公网隧道地址不能是本机回环地址");
  }
  return parsed.origin;
}

export function accessUrl(origin: string, token: string) {
  const base = `${origin.replace(/\/$/, "")}/`;
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}
