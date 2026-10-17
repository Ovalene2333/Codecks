export interface ComposerImage {
  id: string;
  name: string;
  url: string;
}

export interface MessageImage {
  url: string;
  alt?: string;
}

export const MAX_COMPOSER_IMAGES = 8;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function isImageFile(file: File) {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
  );
}

export async function fileToComposerImage(file: File): Promise<ComposerImage> {
  if (!isImageFile(file)) throw new Error(`${file.name} 不是图片`);
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error(`${file.name} 超过 6MB，请压缩后再贴`);
  const url = await readFileAsDataUrl(file);
  if (!url.startsWith("data:image/"))
    throw new Error(`${file.name} 无法读取为图片`);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "image",
    url,
  };
}

export async function collectComposerImages(
  incoming: ArrayLike<File>,
  existing: ComposerImage[],
) {
  const files = Array.from(incoming).filter(isImageFile);
  if (!files.length) return { images: existing };
  const room = MAX_COMPOSER_IMAGES - existing.length;
  if (room <= 0) throw new Error(`最多附加 ${MAX_COMPOSER_IMAGES} 张图片`);
  const next = [...existing];
  for (const file of files.slice(0, room))
    next.push(await fileToComposerImage(file));
  if (files.length > room)
    throw new Error(`最多附加 ${MAX_COMPOSER_IMAGES} 张图片`);
  return { images: next };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function imageUrl(part: any): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const encoded = part.b64_json || part.base64;
  if (typeof encoded === "string" && encoded)
    return `data:image/png;base64,${encoded}`;
  return (
    [
      part.url,
      part.image_url,
      part.imageUrl,
      part.src,
      part.path,
      part.savedPath,
      part.saved_path,
      part.result,
    ].find(
      (value) => typeof value === "string" && value,
    ) || ""
  );
}

function isRenderableImageUrl(url: string) {
  return (
    /^data:image\//i.test(url) ||
    /^blob:/i.test(url) ||
    /^https?:\/\//i.test(url) ||
    /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i.test(url)
  );
}

const IMAGE_TARGET_PREFIX_RE = /^(?:https?:\/\/|\/|~\/|\.{1,2}\/|[a-z]:[\\/])/i;
const IMAGE_TARGET_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:[?#].*)?$/i;

/**
 * 无类型嵌套扫描（item.result/output/data/items 里的负载）的判据：
 * 必须长得像真实图片地址——data:image/blob URI，或以路径/URL 开头、
 * 以图片扩展名结尾。普通文本输出、任意 http(s) 链接、.ts 之类的文件
 * 路径都不算，否则工具结果里的字符串会被误识别为图片。
 */
function looksLikeImageTarget(url: string) {
  return (
    /^data:image\//i.test(url) ||
    /^blob:/i.test(url) ||
    (IMAGE_TARGET_PREFIX_RE.test(url) && IMAGE_TARGET_EXT_RE.test(url))
  );
}

function collectImageParts(item: any, requireImageType: boolean) {
  const parts: MessageImage[] = [];
  const push = (part: any) => {
    if (!part) return;
    const type = String(part.type || "");
    if (
      requireImageType &&
      ![
        "image",
        "localImage",
        "inputImage",
        "input_image",
        "output_image",
        "outputImage",
        "imageView",
        "image_view",
        "imageGeneration",
        "image_generation",
      ].includes(type)
    )
      return;
    const url = imageUrl(part);
    if (
      url &&
      (requireImageType ? isRenderableImageUrl(url) : looksLikeImageTarget(url))
    ) {
      const alt = part.name || part.alt || part.title;
      parts.push(alt ? { url, alt } : { url });
    }
  };
  if (Array.isArray(item?.content)) item.content.forEach(push);
  if (Array.isArray(item?.images)) item.images.forEach(push);
  return parts;
}

export function userImageParts(item: any): MessageImage[] {
  return collectImageParts(item, true);
}

export function assistantImageParts(item: any): MessageImage[] {
  const parts = collectImageParts(item, true);
  for (const nested of [
    item,
    item?.items,
    item?.result,
    item?.output,
    item?.data,
  ]) {
    const nestedParts = collectImageParts(
      { content: Array.isArray(nested) ? nested : [nested] },
      false,
    );
    for (const part of nestedParts)
      if (!parts.some((existing) => existing.url === part.url))
        parts.push(part);
  }
  const direct = [
    item?.image,
    item?.image_url,
    item?.imageUrl,
    item?.output_image,
  ].map(imageUrl);
  for (const url of direct) {
    if (
      url &&
      isRenderableImageUrl(url) &&
      !parts.some((part) => part.url === url)
    )
      parts.push({ url });
  }
  return parts;
}
