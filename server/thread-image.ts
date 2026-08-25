import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export async function resolveThreadImage(cwd: string, requestedPath: string) {
  if (!cwd || !requestedPath || requestedPath.includes("\0"))
    throw new Error("图片路径无效");
  const root = await realpath(cwd);
  const candidate = await realpath(path.resolve(requestedPath));
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("图片不在会话工作目录内");
  if (!IMAGE_FILE.test(candidate)) throw new Error("不支持的图片格式");
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("图片文件不存在");
  if (info.size > MAX_IMAGE_BYTES) throw new Error("图片超过 30MB");
  return candidate;
}
