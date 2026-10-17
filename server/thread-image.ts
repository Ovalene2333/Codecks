import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

function imagePath(value: string, cwd: string) {
  return /^file:/i.test(value)
    ? fileURLToPath(value)
    : path.resolve(cwd, value);
}

/** 仅提取结构化图片项；普通消息、命令输出里的任意路径不作为授权依据。 */
export function referencedThreadImages(thread: any): string[] {
  const result: string[] = [];
  const imageTypes = new Set([
    "imageview",
    "imagegeneration",
    "image",
    "localimage",
    "inputimage",
    "outputimage",
  ]);
  const visit = (item: any) => {
    if (!item || typeof item !== "object") return;
    if (
      imageTypes.has(
        String(item.type || "")
          .replaceAll("_", "")
          .toLowerCase(),
      )
    ) {
      for (const key of [
        "path",
        "url",
        "image_url",
        "imageUrl",
        "savedPath",
        "saved_path",
      ])
        if (
          typeof item[key] === "string" &&
          !/^(?:data|https?|blob):/i.test(item[key])
        )
          result.push(item[key]);
    }
    for (const key of ["content", "images"])
      if (Array.isArray(item[key])) item[key].forEach(visit);
  };
  for (const turn of thread?.turns || [])
    for (const item of turn.items || []) visit(item);
  return result;
}

export async function resolveThreadImage(
  cwd: string,
  requestedPath: string,
  references?: () => Promise<string[]>,
) {
  if (!cwd || !requestedPath || requestedPath.includes("\0"))
    throw new Error("图片路径无效");
  const root = await realpath(cwd);
  const candidate = await realpath(imagePath(requestedPath, cwd));
  const relative = path.relative(root, candidate);
  if (!IMAGE_FILE.test(candidate)) throw new Error("不支持的图片格式");
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    const paths = references ? await references() : [];
    let referenced = false;
    for (const value of paths) {
      try {
        if ((await realpath(imagePath(value, cwd))) === candidate) {
          referenced = true;
          break;
        }
      } catch {
        /* 历史图片可能已被删除，继续核对其它引用。 */
      }
    }
    if (!referenced)
      throw new Error("图片不在会话工作目录内，也未被此会话引用");
  }
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("图片文件不存在");
  if (info.size > MAX_IMAGE_BYTES) throw new Error("图片超过 30MB");
  return candidate;
}
