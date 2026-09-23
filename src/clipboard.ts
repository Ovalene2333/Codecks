// navigator.clipboard 只在安全上下文（HTTPS / localhost）可用；通过局域网 HTTP
// 访问时整个 API 不存在，直接调用会抛 TypeError。降级到 execCommand 兼容路径。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 写入被拒（如无焦点/权限）时继续走降级路径
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
