import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

function isFile(file: string) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file: string, platform: NodeJS.Platform) {
  if (!isFile(file)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 与 spawn 的解析规则一致地判断命令能不能被找到：带路径按路径判断，
 * 否则逐个搜索 PATH。Windows 下补 PATHEXT 后缀（npm 的 .cmd shim 也算）。
 * 只用来给「默认是否加载」提供依据，不执行命令。
 */
export function commandExists(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const name = command.trim();
  if (!name || /[\r\n\0]/.test(name)) return false;
  const win = platform === "win32";
  const extensions = win
    ? [
        "",
        ...String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean),
      ]
    : [""];
  const candidates = (base: string) =>
    extensions.map((extension) => `${base}${extension}`);
  if (/[\\/]/.test(name))
    return candidates(name).some((file) => isExecutable(file, platform));
  const pathValue = (win ? env.Path || env.PATH : env.PATH) || "";
  const delimiter = win ? ";" : path.delimiter;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    if (
      candidates(path.join(dir, name)).some((file) =>
        isExecutable(file, platform),
      )
    )
      return true;
  }
  return false;
}
