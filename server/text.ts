// 文本窗口裁剪：头+尾保留，中间标注省略量。
// 用于工具输出（pwsh / MCP / search）——异常与错误信息常在开头，只留尾部会丢掉最有用的部分。
// 按换行边界切，避免出现半行；没有换行时按代理对边界切，避免劈开 emoji/生僻字。
export function clipMiddle(text: string, max: number, headChars = 2000): string {
  if (text.length <= max) return text
  let headEnd = Math.min(headChars, text.length)
  const headNl = text.lastIndexOf('\n', headEnd)
  if (headNl > 0) headEnd = headNl
  else if (headEnd > 0 && /[\uD800-\uDBFF]/.test(text[headEnd - 1])) headEnd--
  let tailStart = Math.max(0, text.length - (max - headChars))
  const tailNl = text.indexOf('\n', tailStart)
  if (tailNl >= 0) tailStart = tailNl + 1
  else if (tailStart > 0 && /[\uDC00-\uDFFF]/.test(text[tailStart])) tailStart++
  const head = text.slice(0, headEnd)
  const tail = text.slice(tailStart)
  return `${head}\n[... 省略 ${text.length - head.length - tail.length} 字符 ...]\n${tail}`
}
