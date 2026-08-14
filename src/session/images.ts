export interface ComposerImage {
  id: string;
  name: string;
  url: string;
}

export const MAX_COMPOSER_IMAGES = 8;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
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

export function userImageParts(item: any): { url: string; alt?: string }[] {
  const parts: { url: string; alt?: string }[] = [];
  const push = (part: any) => {
    if (!part || typeof part !== "object") return;
    const type = String(part.type || "");
    if (
      type !== "image" &&
      type !== "localImage" &&
      type !== "inputImage" &&
      type !== "input_image"
    )
      return;
    const url =
      typeof part.url === "string"
        ? part.url
        : typeof part.image_url === "string"
          ? part.image_url
          : typeof part.path === "string"
            ? part.path
            : "";
    if (url) parts.push({ url, alt: part.name || part.alt });
  };
  if (Array.isArray(item?.content)) item.content.forEach(push);
  if (Array.isArray(item?.images)) item.images.forEach(push);
  return parts;
}
