import express from 'express'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { errMsg, readSettings } from './config.ts'
import { readMemories } from './memories.ts'
import { sessions, saveSession } from './sessions.ts'
import { contextTokens, getOpenAI, normalizeMessage, toApiMessages } from './upstream.ts'
import { currentTools, executeTool } from './tools.ts'
import { addUsage, compactContext } from './compact.ts'
import type { Entry, Session, ToolCall, Usage } from './types.ts'

// ===== 生成核心：服务端驱动流式、把条目写进会话、写穿磁盘 =====
// 浏览器侧私有 NDJSON 事件（与 OpenAI 协议解耦）：
//   h=应用指令后的权威历史 a=新assistant条目(含位置/预填) c/r=正文/思考增量(带条目id)
//   t=工具调用片段 x=工具结果条目 m=压缩气泡(新/定稿) e=错误 d=结束(带权威历史)

interface GenerateOpts {
  insertPos: number
  signal: AbortSignal
  // 重试：staleFrom 起的旧内容（旧回答/旧条目）保留展示，当轮首个输出到达时删除；无输出（失败/停止）则原样保留
  staleFrom?: number
}

export async function generate(session: Session, w: (o: unknown) => void, finish: () => void, opts: GenerateOpts): Promise<void> {
  const s = readSettings()
  if (!s.baseUrl || !s.model) {
    w({ e: '未配置服务器地址/模型，请先在"设置"中配置' })
    w({ d: 1, title: session.title, history: session.history })
    finish()
    return
  }
  let pos = opts.insertPos
  let failed: string | null = null
  let done = false
  const usage: Usage = { prompt: 0, completion: 0, total: 0 }
  let overflowRetried = false // 超窗 400 的自动压缩重试：整个生成过程最多一次（每轮重置会无限循环）
  for (let round = 0; !failed && !done; round++) {
    // 当轮 assistant 条目：立即进入会话（服务器事实永远完整），断点/崩溃后也是合法半截
    const entry: Entry = { id: randomUUID(), role: 'assistant', content: '', ts: Date.now() }
    session.history.splice(pos, 0, entry)
    saveSession(session)
    w({ a: entry.id, pos })
    let full = ''
    let think = ''
    const toolCalls: ToolCall[] = []
    // 重试：首个输出到达时删除旧内容（staleFrom 起），并把已流出的部分内容同步进条目（h 事件全量替换客户端历史）
    const dropStale = () => {
      if (opts.staleFrom == null) return
      const from = opts.staleFrom
      opts.staleFrom = undefined // 一次性：只删首个输出前的旧内容，后续轮次的工具条目不受影响
      entry.content = full
      if (think) entry.reasoning = think
      if (toolCalls.length) entry.tool_calls = toolCalls
      session.history.splice(from)
      saveSession(session)
      w({ h: session.history })
    }
    if (s.maxContext > 0) {
      // 上下文本身已超窗（如删除压缩气泡后恢复）：直接报错，不尝试自动压缩
      const used = contextTokens(session.history.filter((e) => e.id !== entry.id))
      if (used > s.maxContext) {
        failed = `当前上下文约 ${used} token，已超过模型窗口（${s.maxContext}），无法自动压缩，请手动删除部分消息后继续`
        break
      }
    }
    // 上游停滞保护：120 秒无任何输出即中止（上游卡死会把会话永久锁在生成中）
    const stallCtl = new AbortController()
    const onUserAbort = () => stallCtl.abort()
    opts.signal.addEventListener('abort', onUserAbort)
    let stallTimer: NodeJS.Timeout | undefined
    let stalled = false
    const armStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        stallCtl.abort()
      }, 120_000)
    }
    try {
      const allTools = currentTools()
      let messages = toApiMessages(session.history.slice(0, pos))
      const memories = readMemories()
      if (memories.length) messages = [{ role: 'developer', content: memories.join('\n') }, ...messages]
      const stream = await getOpenAI(s.baseUrl, s.apiKey).chat.completions.create(
        {
          model: s.model,
          messages: messages.map(normalizeMessage) as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
          stream: true,
          stream_options: { include_usage: true },
          ...(allTools.length ? { tools: allTools } : {}),
          ...(s.maxTokens > 0 ? { max_tokens: s.maxTokens } : {}),
          ...(s.effort ? { reasoning_effort: s.effort as OpenAI.ReasoningEffort } : {}),
        },
        { signal: stallCtl.signal },
      )
      armStall()
        for await (const chunk of stream) {
          armStall()
          if (opts.signal.aborted) break
        const delta = chunk.choices?.[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }) | undefined
        if (!delta) continue
        if (delta.content != null || delta.reasoning_content != null || (delta.tool_calls?.length)) dropStale()
        if (delta.content != null) {
          full += delta.content
          w({ id: entry.id, c: delta.content })
        }
        if (delta.reasoning_content != null) {
          think += delta.reasoning_content
          w({ id: entry.id, r: delta.reasoning_content })
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0
          const slot = toolCalls[i] ?? (toolCalls[i] = { id: '', name: '', arguments: '' })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) slot.arguments += tc.function.arguments
          const o: Record<string, unknown> = { i }
          if (tc.id) o.id = tc.id
          if (tc.function?.name) o.n = tc.function.name
          if (tc.function?.arguments) o.a = tc.function.arguments
          w({ id: entry.id, t: o })
        }
        addUsage(usage, chunk.usage)
      }
    } catch (err) {
      if (opts.signal.aborted) {
        // 用户停止：已输出内容入库（服务器是唯一事实源），无 e 无 d；无任何输出则移除空条目，保持上下文原样
        entry.content = full || null
        if (think) entry.reasoning = think
        if (!full && !think && !toolCalls.length) session.history.splice(session.history.indexOf(entry), 1)
        saveSession(session)
        return
      }
      // 超窗保护：上游 400 prompt 过长 → 压缩一次并重试本轮（覆盖估算残差；压缩自身失败则走 failed）
      if (!overflowRetried && s.maxContext > 0 && /exceeds|prompt length|context length|too long/i.test(errMsg(err))) {
        overflowRetried = true
        await compactContext(session, w, opts.signal, usage)
        continue
      }
      failed = stalled ? '上游生成停滞（120 秒无输出），已中止' : errMsg(err)
      if (overflowRetried && !stalled) failed += '（已尝试自动压缩，上下文仍超窗，请手动删除部分消息后继续）'
    } finally {
      clearTimeout(stallTimer)
      opts.signal.removeEventListener('abort', onUserAbort)
    }
    // 当轮结束：条目定稿入库；无任何输出（失败或空完成）时移除空条目——空 assistant 消息会污染/拒绝上游
    entry.content = full || null
    if (think) entry.reasoning = think
    if (toolCalls.length) entry.tool_calls = toolCalls
    if (!full && !think && !toolCalls.length) {
      session.history.splice(session.history.indexOf(entry), 1)
      if (!failed) failed = '模型返回了空内容，请重试'
    }
    saveSession(session)
    if (failed) break
    // 气泡完成后检测压缩触发：已用 > 窗口 - max(32k, 最大输出)（留估算误差余量）
    if (s.maxContext > 0 && contextTokens(session.history) > s.maxContext - Math.max(32768, s.maxTokens)) {
      await compactContext(session, w, opts.signal, usage)
    }
    if (!toolCalls.length) {
      done = true
      break
    }
    // 工具轮：服务器执行，结果成条目入库
    for (const tc of toolCalls) {
      const te: Entry = { id: randomUUID(), role: 'tool', tool_call_id: tc.id, content: '', ts: Date.now() }
      session.history.push(te)
      w({ x: te.id, pos: session.history.length - 1, tc: tc.id })
      let out: string
      try {
        const r = await executeTool(tc, opts.signal)
        out = r.text
        if (r.images?.length) te.images = r.images
      } catch {
        out = '(已停止)'
      }
      te.content = out
      saveSession(session)
      w({ x: te.id, r: out, tc: tc.id, ...(te.images ? { imgs: te.images } : {}) })
      if (s.maxContext > 0 && contextTokens(session.history) > s.maxContext - Math.max(32768, s.maxTokens)) {
        await compactContext(session, w, opts.signal, usage)
      }
    }
    pos = session.history.length
  }
  if (opts.signal.aborted) return
  if (failed) w({ e: failed })
  w({ d: 1, title: session.title, history: session.history, contextTokens: contextTokens(session.history), ...(usage.total ? { usage } : {}) })
  finish()
}

// ===== 生成与连接解耦：生成独立于任何 HTTP 连接运行 =====
// 每个进行中的生成：事件缓冲（供新连接重放重建视图）+ 当前附加的响应集合
// 客户端断开只移除连接，不中断生成；停止走显式 POST /stop
export interface Gen {
  controller: AbortController
  events: unknown[]
  clients: Set<express.Response>
}
export const gens = new Map<number, Gen>()
export const ndjsonHeaders = (res: express.Response) => {
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
}
export const makeW = (g: Gen): ((o: unknown) => void) => (o) => {
  g.events.push(o)
  for (const r of g.clients) if (!r.destroyed) r.write(JSON.stringify(o) + '\n')
}
export const endAll = (g: Gen) => {
  for (const r of [...g.clients]) if (!r.writableFinished) {
    try {
      r.end()
    } catch {
      // 已断开
    }
  }
}
// 附加一个响应：重放已缓冲事件（新连接据此重建完整视图），随后实时转发
export function attachClient(g: Gen, res: express.Response) {
  ndjsonHeaders(res)
  g.clients.add(res)
  for (const e of g.events) res.write(JSON.stringify(e) + '\n')
  res.on('close', () => g.clients.delete(res))
}

// 生成端点公共骨架：会话校验 + 忙锁
export function guardSession(req: express.Request, res: express.Response): Session | null {
  const s = sessions.get(Number(req.params.id))
  if (!s) {
    res.status(404).json({ error: '会话不存在' })
    return null
  }
  if (gens.has(s.id)) {
    res.status(409).json({ error: '会话正在生成中' })
    return null
  }
  return s
}