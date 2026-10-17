import { createContext, useContext, useEffect } from "react";

/**
 * 设置里各个表单向外壳汇报「有未保存的修改」：外壳据此在导航上点一个
 * 圆点，并在关闭设置前弹确认。键名约定 `页面:表单`，如 `session:defaults`。
 */
export const DirtyContext = createContext<
  (key: string, dirty: boolean) => void
>(() => undefined);

export function useDirtyFlag(key: string, dirty: boolean) {
  const report = useContext(DirtyContext);
  useEffect(() => {
    report(key, dirty);
  }, [key, dirty, report]);
  // 卸载时清掉，避免已关闭的表单留下「未保存」幽灵标记。
  useEffect(() => () => report(key, false), [key, report]);
}
