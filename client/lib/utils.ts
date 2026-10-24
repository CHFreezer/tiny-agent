export { cn } from "cn"

// 可见文本：忽略空白、零宽空格/连接符、方向标记、BOM 等不可见字符。
// 上游在纯工具调用轮次有时会先吐一个 ​ 占位，trim() 去不掉它。
export const hasVisibleText = (s?: string | null): s is string =>
  !!s && /[^\s​-‏‪-‮⁠-⁯﻿]/.test(s)
