import { randomUUID } from 'node:crypto'
import { errMsg, readSettings } from './config.ts'
import { saveSession } from './sessions.ts'
import { buildChatRequest, getOpenAI } from './upstream.ts'
import type { Entry, Session, Usage } from './types.ts'

// ===== 自动上下文压缩 =====
// 每个气泡完成后检测：已用 token > 窗口 - max(20k, 最大输出) 时，对当前有效上下文生成结构化摘要，
// 落一个 summary 条目作为分割点（历史不删，只影响后续请求的上下文构成）
const SUMMARY_PROMPT = `What did we do so far?

请输出结构化摘要。要求：
- 严格按以下模板，所有 section 必须保留，即使为空也写 (none)
- 使用简短 bullet，不写长篇 prose
- 尽可能保留精确的文件路径、函数/类名、命令、错误字符串、URL、标识符
- 不要提及"压缩/摘要"等元信息

模板：

Objective
- 用户当前想完成什么

Important Details
- 约束 / 偏好
- 重要决策以及原因
- 关键事实 / 假设
- 后续继续任务必须知道的上下文

Work State

### Completed
- 已完成的工作
- 已验证的事实
- 已经做出的修改

### Active
- 当前正在做的事情
- 未完成的修改
- 当前调查状态

### Blocked
- blocker
- 失败的命令
- 仍然未知的问题

Next Move
1. 下一步立即应该做什么
2. 如果明确的话，再写下一步

Relevant Files
- 文件或目录路径：为什么重要`

export const addUsage = (u: Usage, c?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null) => {
  if (!c) return
  u.prompt += c.prompt_tokens ?? 0
  u.completion += c.completion_tokens ?? 0
  u.total += c.total_tokens ?? 0
}

export async function compactContext(session: Session, w: (o: unknown) => void, signal: AbortSignal, usage: Usage): Promise<void> {
  const s = readSettings()
  const entry: Entry = { id: randomUUID(), role: 'summary', content: '', ts: Date.now() }
  session.history.push(entry)
  saveSession(session)
  w({ m: { id: entry.id, pos: session.history.length - 1 } })
  let full = ''
  let finish: string | null = null
  let streamErr: string | null = null
  try {
    // 输入 = 当前有效上下文（排除本气泡，沿用已有分割点）+ 摘要指令
    // 与主请求共用 buildChatRequest 构建，前缀/tools 完全一致避免 cache miss
    const stream = await getOpenAI(s.baseUrl, s.apiKey).chat.completions.create(
      buildChatRequest({
        history: session.history.filter((e) => e.id !== entry.id),
        extra: [{ role: 'user', content: SUMMARY_PROMPT }],
      }),
      { signal },
    )
    for await (const chunk of stream) {
      if (signal.aborted) break
      const choice = chunk.choices?.[0]
      if (choice?.delta?.content) {
        full += choice.delta.content
        w({ id: entry.id, c: choice.delta.content })
      }
      if (choice?.finish_reason) finish = choice.finish_reason
      addUsage(usage, chunk.usage)
    }
  } catch (err) {
    if (!signal.aborted) streamErr = errMsg(err)
  }
  // 输出被截断（length）/报错/空 → 失败：保留已输出内容展示，但不是有效分割点
  const ok = !streamErr && finish !== 'length' && full.trim().length > 0
  entry.content = full || null
  if (!ok) entry.summaryStatus = 'failed'
  saveSession(session)
  w({ m: { id: entry.id, ok, ...(ok ? {} : { err: streamErr ?? (finish === 'length' ? '摘要输出被截断，压缩失败' : '摘要生成失败') }) } })
}