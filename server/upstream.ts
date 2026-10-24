import OpenAI from 'openai'
import { readMemories } from './memories.ts'
import { currentTools } from './tools.ts'
import { imageInfo, toDataUrl } from './images.ts'
import { readSettings } from './config.ts'
import type { Entry } from './types.ts'

// ===== 上游（100% OpenAI 标准，官方 SDK） =====
const clients = new Map<string, OpenAI>()
export function getOpenAI(base: string, apiKey = ''): OpenAI {
  const key = `${base}::${apiKey}`
  let c = clients.get(key)
  if (!c) {
    c = new OpenAI({ baseURL: base, apiKey: apiKey || 'not-needed' })
    clients.set(key, c)
  }
  return c
}

// 上游请求选项：只附加面板里显式配置的自定义请求头。
// 不在代码里假设任何后端（如 OpenCode Go 的 x-opencode-session）——需要什么头由用户在设置里自行配置。
export const upstreamRequest = (signal?: AbortSignal) => {
  const headers = readSettings().headers ?? {}
  return {
    ...(signal ? { signal } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  }
}

// 消息规范化：OpenAI 客户端在 content 为 null 且带 tool_calls 时按空串序列化，
// 部分后端（vLLM/llama.cpp 等）不接受 assistant 空内容 → 补 ""
export const normalizeMessage = (m: unknown): Record<string, unknown> => {
  const o = { ...(m as Record<string, unknown>) }
  if (o.role === 'assistant' && o.tool_calls && o.content == null) o.content = ''
  return o
}

// 会话历史 → OpenAI 标准消息
// 上下文分割点：最近一次成功的压缩气泡；其前历史（含更早压缩气泡）不计入当前上下文
// 悬挂工具调用消毒：停止/崩溃后 assistant 可能带 tool_calls 而无（完整）tool 结果——上游会 400。
// 结果缺失时丢弃 tool_calls（保留文本/思考）及配套的孤儿 tool 结果；整条变空壳则删除
function sanitizeToolCalls(msgs: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const missing = new Set(m.tool_calls.map((t: { id: string }) => t.id))
      let j = i + 1
      while (j < msgs.length && msgs[j].role === 'tool') {
        missing.delete(msgs[j].tool_call_id as string)
        j++
      }
      if (missing.size) {
        const { tool_calls: _tc, ...rest } = m
        if (rest.content != null || rest.reasoning_content) out.push(rest)
        i = j - 1
        continue
      }
    }
    out.push(m)
  }
  return out
}

export function toApiMessages(history: Entry[]) {
  const mapEntry = (m: Entry): Record<string, unknown>[] => {
    // summary 只是客户端展示用的条目：唯一被选作分割点的摘要在下方以 assistant 注入，
    // 其余（失败的、或位于分割点之后的）一律不发给上游——role: "summary" 不是合法 OpenAI role
    if (m.role === 'summary') return []
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const e: Record<string, unknown> = {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }
      // 思考回喂：本地 llama.cpp 认 reasoning_content，commandcode 网关认 reasoning，两个字段都带；
      // 历史条目一旦生成即稳定，前缀一致不破坏 prompt cache；都不认的服务器忽略（实测网关回喂不计入 prompt）
      if (m.reasoning) {
        e.reasoning_content = m.reasoning
        e.reasoning = m.reasoning
      }
      return [e]
    }
    if (m.role === 'tool') {
      // tool 消息只能放文本；图片由 mapEntries 在整轮 tool 结果之后合并成一条 user 消息
      return [{ role: 'tool', tool_call_id: m.tool_call_id, content: m.content }]
    }
    if (m.role === 'assistant' && m.reasoning) {
      return [{ role: 'assistant', content: m.content, reasoning_content: m.reasoning, reasoning: m.reasoning }]
    }
    if (m.role === 'user' && m.images?.length) {
      const content: Array<Record<string, unknown>> = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const url of m.images) content.push({ type: 'image_url', image_url: { url: toDataUrl(url) } })
      return [{ role: 'user', content }]
    }
    return [{ role: m.role, content: m.content }]
  }

  // 工具结果图片：OpenAI Chat Completions 的 tool 消息只支持文本，图片必须以 user 消息注入。
  // 同一条 assistant 的连续 tool 结果必须保持相邻，所以图片先收集，整轮结束后再合并成一条 user，
  // 避免插在 tool 消息之间导致 sanitizeToolCalls 误判"缺少工具结果"并丢弃整条 tool_calls。
  const imageLabel = (entry: Entry, info: ReturnType<typeof imageInfo>) => {
    const size = info.width && info.height ? `${info.width}×${info.height}` : '尺寸未知'
    const bytes = info.bytes > 0 ? `，${info.bytes} 字节` : ''
    return `[工具结果图片] tool_call_id=${entry.tool_call_id ?? '?'}；${info.mime}；${size}${bytes}`
  }
  const mapEntries = (entries: Entry[]): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    let pending: Record<string, unknown>[] = []
    const flush = () => {
      if (!pending.length) return
      out.push({ role: 'user', content: pending })
      pending = []
    }
    for (const entry of entries) {
      if (entry.role === 'tool') {
        out.push(...mapEntry(entry))
        for (const src of entry.images ?? []) {
          const info = imageInfo(src)
          pending.push({ type: 'text', text: imageLabel(entry, info) })
          pending.push({ type: 'image_url', image_url: { url: info.url } })
        }
        continue
      }
      flush()
      out.push(...mapEntry(entry))
    }
    flush()
    return out
  }

  let sumIdx = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'summary' && !history[i].summaryStatus) {
      sumIdx = i
      break
    }
  }
  if (sumIdx < 0) {
    return sanitizeToolCalls(mapEntries(history.filter((m) => !(m.role === 'system' && !m.content?.trim()))))
  }
  const msgs: Record<string, unknown>[] = []
  for (const m of history.slice(0, sumIdx)) {
    if (m.role === 'system' && m.content?.trim()) msgs.push({ role: 'system', content: m.content })
  }
  msgs.push({ role: 'user', content: 'What did we do so far?' })
  msgs.push({ role: 'assistant', content: history[sumIdx].content ?? '' })
  msgs.push(...mapEntries(history.slice(sumIdx + 1)))
  msgs.push({ role: 'user', content: '从这里继续调用工具或者给出答案' })
  return sanitizeToolCalls(msgs)
}

// 会话创建时间 → 可读时间（含时区偏移），供 developer 注入让模型知道"现在"
const formatTime = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (UTC${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)})`
}
// developer 注入内容：当前时间（会话创建时）+ 用户记忆
const devContent = (createdAt: number): string => {
  const parts = [`当前时间：${formatTime(createdAt)}`]
  const memories = readMemories()
  if (memories.length) parts.push(...memories)
  return parts.join('\n')
}

// 构建发往 OpenAI SDK 的完整请求载荷——主请求与压缩请求共用此唯一实现。
// 除 history（调用方切片/过滤）与 extra（压缩请求的摘要指令）外，所有字段
// （model/tools/max_tokens/reasoning_effort/developer 注入）都从 settings 读取，
// 调用方无法传入任何会改变请求的字段——从结构上杜绝两请求分叉导致前缀 cache miss。
export function buildChatRequest(opts: {
  history: Entry[]
  extra?: Record<string, unknown>[]
  createdAt: number
}): {
  model: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  stream: true
  stream_options: { include_usage: true }
  tools?: OpenAI.Chat.ChatCompletionTool[]
  max_tokens?: number
  reasoning_effort?: OpenAI.ReasoningEffort
  reasoning?: { effort: string }
  thinking?: { type: string }
  chat_template_kwargs?: { enable_thinking?: boolean; reasoning_effort?: string }
} {
  const s = readSettings()
  const allTools = currentTools()
  let messages = toApiMessages(opts.history)
  const devMsg = { role: 'developer', content: devContent(opts.createdAt) }
  const sysIdx = messages.findIndex((m) => m.role === 'system')
  messages.splice(sysIdx >= 0 ? sysIdx + 1 : 0, 0, devMsg)
  if (opts.extra?.length) messages = [...messages, ...opts.extra]
  return {
    model: s.model,
    messages: messages.map(normalizeMessage) as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
    stream: true,
    stream_options: { include_usage: true },
    ...(allTools.length ? { tools: allTools } : {}),
    ...(s.maxTokens > 0 ? { max_tokens: s.maxTokens } : {}),
    // effort：各家认的字段不同，多个一起发（不认的忽略）；reasoning_effort 是少数会做枚举校验的字段（commandcode 只认 low|medium|high|xhigh|max，传别的值 400，错误原样透给前端）
    ...(s.effort === 'none'
      ? { reasoning_effort: 'none' as OpenAI.ReasoningEffort, reasoning: { effort: 'none' }, thinking: { type: 'disabled' }, chat_template_kwargs: { enable_thinking: false } }
      : s.effort
        ? { reasoning_effort: s.effort as OpenAI.ReasoningEffort, reasoning: { effort: s.effort }, chat_template_kwargs: { reasoning_effort: s.effort } }
        : {}),
  }
}
