import express from 'express'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { errMsg, readSettings } from './config.ts'
import { sessions, saveSession } from './sessions.ts'
import { buildChatRequest, getOpenAI } from './upstream.ts'
import { executeTool } from './tools.ts'
import { storeImage } from './images.ts'
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
  let roundBase = 0 // 最近一次主请求的精确 prompt_tokens（上游分词器，usage 末尾 chunk）
  let lastCompletion = 0 // 最近一次主请求响应的精确 completion_tokens
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
    // 上游停滞保护：生成阶段 120 秒无输出即中止（上游卡死会把会话永久锁在生成中）；
    // prefill 阶段（首 chunk 前）放宽到 600 秒——大上下文 prefill 可达数分钟（~1000 tps × 20 万 token ≈ 200s）
    const stallCtl = new AbortController()
    const onUserAbort = () => stallCtl.abort()
    opts.signal.addEventListener('abort', onUserAbort)
    let stallTimer: NodeJS.Timeout | undefined
    let stalled = false
    let gotFirstChunk = false
    const armStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        stallCtl.abort()
      }, gotFirstChunk ? 120_000 : 600_000)
    }
    const t0 = Date.now() // 本轮请求起点：空流时区分 prefill 超时与模型真空输出
    try {
      const baseBefore = usage.prompt
      const completionBefore = usage.completion
      const stream = await getOpenAI(s.baseUrl, s.apiKey).chat.completions.create(
        buildChatRequest({
          history: session.history.slice(0, pos),
          createdAt: session.createdAt,
        }),
        { signal: stallCtl.signal },
      )
      armStall()
        for await (const chunk of stream) {
          gotFirstChunk = true
          armStall()
          if (opts.signal.aborted) break
        const delta = chunk.choices?.[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string }) | undefined
        if (!delta) continue
        // 思考字段兼容：本地 llama.cpp 回 reasoning_content，commandcode 网关回 reasoning
        const thinkDelta = delta.reasoning_content ?? delta.reasoning
        if (delta.content != null || thinkDelta != null || (delta.tool_calls?.length)) dropStale()
        if (delta.content != null) {
          full += delta.content
          w({ id: entry.id, c: delta.content })
        }
        if (thinkDelta != null) {
          think += thinkDelta
          w({ id: entry.id, r: thinkDelta })
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
      roundBase = usage.prompt - baseBefore // 本次请求的精确 prompt token 数（上游不支持 usage 时为 0）
      lastCompletion = usage.completion - completionBefore
      if (roundBase > 0) {
        // 流中途停止时 usage 未到达（roundBase=0）：保留上次的精确值，不覆盖
        session.lastPromptTokens = roundBase
        session.lastCompletionTokens = lastCompletion
        // 实时用量：每次主请求返回后立刻推送精确值（顶栏不必等生成结束）
        w({ lastPromptTokens: session.lastPromptTokens, lastCompletionTokens: session.lastCompletionTokens })
      }
    } catch (err) {
      if (opts.signal.aborted) {
        // 用户停止：已输出内容入库（服务器是唯一事实源），无 e；d 收尾让所有客户端（含 attach 流）清 busy
        entry.content = full || null
        if (think) entry.reasoning = think
        if (!full && !think && !toolCalls.length) session.history.splice(session.history.indexOf(entry), 1)
        saveSession(session)
        w({ d: 1, title: session.title, history: session.history, lastPromptTokens: session.lastPromptTokens, lastCompletionTokens: session.lastCompletionTokens })
        return
      }
      failed = stalled ? '上游生成停滞（120 秒无输出），已中止' : errMsg(err)
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
      // 空条目移除后重发权威历史：客户端镜像同步，避免幽灵空气泡
      w({ h: session.history })
      if (!failed) failed = Date.now() - t0 > 30000 ? '上游响应超时（prefill 过长），请重试' : '模型返回了空内容，请重试'
    }
    saveSession(session)
    if (failed) break
    // 气泡完成后检测压缩触发：上次请求的精确 prompt > 窗口 - max(20k, 最大输出)
    if (s.maxContext > 0 && roundBase > 0 && roundBase > s.maxContext - Math.max(20000, s.maxTokens)) {
      await compactContext(session, w, opts.signal, usage)
      roundBase = 0 // 压缩后上下文已缩减，旧 prompt 值失效：防止本轮工具结果后二次触发压缩
    }
    if (opts.signal.aborted) break // 压缩期间停止：不进入工具轮（否则末尾多一个工具结果气泡）
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
        if (r.images?.length) te.images = r.images.map((src) => storeImage(session.id, src))
      } catch {
        out = '(已停止)'
      }
      te.content = out
      saveSession(session)
      w({ x: te.id, r: out, tc: tc.id, ...(te.images ? { imgs: te.images } : {}) })
      if (s.maxContext > 0 && roundBase > 0 && roundBase > s.maxContext - Math.max(20000, s.maxTokens)) {
        await compactContext(session, w, opts.signal, usage)
      }
    }
    pos = session.history.length
  }
  if (opts.signal.aborted) {
    w({ d: 1, title: session.title, history: session.history, lastPromptTokens: session.lastPromptTokens, lastCompletionTokens: session.lastCompletionTokens })
    return
  }
  if (failed) w({ e: failed })
  w({ d: 1, title: session.title, history: session.history, lastPromptTokens: session.lastPromptTokens, lastCompletionTokens: session.lastCompletionTokens, ...(usage.total ? { usage } : {}) })
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