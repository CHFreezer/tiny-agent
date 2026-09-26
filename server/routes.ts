import express from 'express'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DATA_DIR, SETTINGS_FILE, errMsg, readSettings } from './config.ts'
import { readMemories, saveMemories } from './memories.ts'
import {
  applyDelete,
  createSession,
  deleteSession,
  getCurrentId,
  listSorted,
  renameSession,
  saveSession,
  sessions,
  switchSession,
  withLock,
} from './sessions.ts'
import { contextTokens, getOpenAI } from './upstream.ts'
import { mcpStatus, syncMcp } from './mcp.ts'
import { compactContext } from './compact.ts'
import { attachClient, endAll, generate, gens, guardSession, makeW, ndjsonHeaders } from './generate.ts'
import type { Gen } from './generate.ts'
import type { Entry, McpServerConfig, Settings, ToolCall, Usage } from './types.ts'

export function registerRoutes(app: express.Express): void {
  // ===== 设置 =====
  app.get('/api/settings', (_req, res) => {
    res.json(readSettings())
  })

  app.put('/api/settings', (req, res) => {
    const body = req.body as Partial<Settings> & { mcp?: unknown }
    const { baseUrl, mode, model, effort, apiKey } = body
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      return res.status(400).json({ error: 'baseUrl required' })
    }
    const mcp: McpServerConfig[] = Array.isArray(body.mcp)
      ? body.mcp
          .filter((c): c is McpServerConfig => !!c && typeof c.name === 'string' && c.name.trim().length > 0 && typeof c.command === 'string')
          .map((c) => ({
            name: c.name.trim().slice(0, 48),
            command: c.command.slice(0, 512),
            args: typeof c.args === 'string' ? c.args.slice(0, 1024) : '',
            env: typeof c.env === 'string' ? c.env.slice(0, 1024) : '',
            enabled: c.enabled !== false,
          }))
          .filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i)
      : []
    const toPosInt = (v: unknown) => {
      const n = Math.floor(Number(v))
      return Number.isFinite(n) && n > 0 ? Math.min(n, 2000000) : 0
    }
    const maxContext = toPosInt(body.maxContext)
    const maxTokens = toPosInt(body.maxTokens)
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ baseUrl, mode, model, effort, apiKey, mcp, maxContext, maxTokens, pwsh: body.pwsh !== false }))
      void syncMcp() // 配置变更 → 对齐 MCP 连接（后台，不阻塞响应）
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: errMsg(err) })
    }
  })

  // ===== 记忆 =====
  app.get('/api/memories', (_req, res) => {
    res.json({ memories: readMemories() })
  })

  app.put('/api/memories', (req, res) => {
    const { memories } = req.body as { memories?: unknown }
    if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories required' })
    res.json({ memories: saveMemories(memories) })
  })

  // ===== 会话指令 =====
  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: listSorted().map((s) => ({ ...s, contextTokens: contextTokens(s.history), generating: gens.has(s.id) })), currentId: getCurrentId() })
  })

  app.post('/api/sessions', (_req, res) => {
    const s = createSession()
    res.json({ session: s, currentId: getCurrentId() })
  })

  app.post('/api/sessions/:id/switch', (req, res) => {
    const id = Number(req.params.id)
    if (!switchSession(id)) return res.status(404).json({ error: '会话不存在' })
    res.json({ currentId: getCurrentId() })
  })

  app.put('/api/sessions/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!sessions.has(id)) return res.status(404).json({ error: '会话不存在' })
    const { title } = req.body as { title?: string }
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' })
    const s = renameSession(id, title)
    res.json({ session: s })
  })

  app.delete('/api/sessions/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!sessions.has(id)) return res.status(404).json({ error: '会话不存在' })
    if (gens.has(id)) return res.status(409).json({ error: '会话正在生成中' })
    res.json(deleteSession(id)!)
  })

  // 发送消息：服务器追加 user 条目 → 启动生成（流式）
  app.post('/api/sessions/:id/messages', (req, res) => {
    const s = guardSession(req, res)
    if (!s) return
    const { content, images } = req.body as { content?: string; images?: string[] }
    if (typeof content !== 'string' && !Array.isArray(images)) {
      return res.status(400).json({ error: 'content or images required' })
    }
    void withLock(s.id, async () => {
      const g: Gen = { controller: new AbortController(), events: [], clients: new Set() }
      gens.set(s.id, g)
      const w = makeW(g)
      const user: Entry = { id: randomUUID(), role: 'user', content: content ?? '', ts: Date.now() }
      if (Array.isArray(images) && images.length) user.images = images
      s.history.push(user)
      if (s.title === '新会话' && content) s.title = content.slice(0, 20)
      saveSession(s)
      w({ h: s.history })
      attachClient(g, res)
      try {
        await generate(s, w, () => endAll(g), { insertPos: s.history.length, signal: g.controller.signal })
      } catch (err) {
        w({ e: errMsg(err), d: 1, title: s.title, history: s.history })
      } finally {
        endAll(g)
        gens.delete(s.id)
      }
    }).catch((err) => {
      try {
        res.status(500).json({ error: errMsg(err) })
      } catch {
        // 连接已断
      }
    })
  })

  // 重试：从该位置重新生成（前面的条目保留为上下文）；旧内容保留展示，新流首个输出到达时删除
  //   user → 在其下方原位重新生成回答
  //   assistant → 原位重新生成（旧条目暂留其下展示）
  //   tool/system → 不可重试（工具结果不来自上游推理）
  app.post('/api/sessions/:id/messages/:eid/retry', (req, res) => {
    const s = guardSession(req, res)
    if (!s) return
    const entry = s.history.find((e) => e.id === req.params.eid)
    if (!entry) return res.status(404).json({ error: '条目不存在' })
    if (entry.role === 'tool' || entry.role === 'system') return res.status(400).json({ error: '该条目不可重试' })
    const idx = s.history.indexOf(entry)
    // 旧内容（新条目之后的所有条目）不立即删除：保留展示直到新流首个输出到达（generate 内 dropStale）；无输出则原样保留可再重试
    const insertPos = entry.role === 'user' ? idx + 1 : idx
    const staleFrom = insertPos + 1
    void withLock(s.id, async () => {
      const g: Gen = { controller: new AbortController(), events: [], clients: new Set() }
      gens.set(s.id, g)
      const w = makeW(g)
      saveSession(s)
      w({ h: s.history })
      attachClient(g, res)
      try {
        await generate(s, w, () => endAll(g), { insertPos, staleFrom, signal: g.controller.signal })
      } catch (err) {
        w({ e: errMsg(err), d: 1, title: s.title, history: s.history })
      } finally {
        endAll(g)
        gens.delete(s.id)
      }
    }).catch((err) => {
      try {
        res.status(500).json({ error: errMsg(err) })
      } catch {
        // 连接已断
      }
    })
  })

  // 重新附加：页面重开/切换会话时同步进行中的生成（重放缓冲事件 + 实时转发）；未在生成则一次性 d 收尾
  app.get('/api/sessions/:id/stream', (req, res) => {
    const s = sessions.get(Number(req.params.id))
    if (!s) return res.status(404).json({ error: '会话不存在' })
    const g = gens.get(s.id)
    if (!g) {
      ndjsonHeaders(res)
      res.write(JSON.stringify({ d: 1, title: s.title, history: s.history, contextTokens: contextTokens(s.history) }) + '\n')
      res.end()
      return
    }
    attachClient(g, res)
  })

  // 显式停止：唯一的中断来源（客户端断开不再停止生成）
  app.post('/api/sessions/:id/stop', (req, res) => {
    const s = sessions.get(Number(req.params.id))
    if (!s) return res.status(404).json({ error: '会话不存在' })
    const g = gens.get(s.id)
    if (g) g.controller.abort()
    res.json({ ok: true })
  })

  // 手动压缩上下文：与自动压缩同一机制（summary 条目 + 流式事件，气泡实时出现在聊天里）
  app.post('/api/sessions/:id/compact', (req, res) => {
    const s = guardSession(req, res)
    if (!s) return
    if (!s.history.length) return res.status(400).json({ error: '会话为空，无需压缩' })
    void withLock(s.id, async () => {
      const g: Gen = { controller: new AbortController(), events: [], clients: new Set() }
      gens.set(s.id, g)
      const w = makeW(g)
      attachClient(g, res)
      const usage: Usage = { prompt: 0, completion: 0, total: 0 }
      try {
        await compactContext(s, w, g.controller.signal, usage)
      } catch (err) {
        w({ e: errMsg(err) })
      } finally {
        w({ d: 1, title: s.title, history: s.history, contextTokens: contextTokens(s.history), lastPromptTokens: s.lastPromptTokens })
        endAll(g)
        gens.delete(s.id)
      }
    }).catch((err) => {
      try {
        res.status(500).json({ error: errMsg(err) })
      } catch {
        // 连接已断
      }
    })
  })

  // 编辑条目
  app.patch('/api/sessions/:id/messages/:eid', (req, res) => {
    const s = guardSession(req, res)
    if (!s) return
    const entry = s.history.find((e) => e.id === req.params.eid)
    if (!entry) return res.status(404).json({ error: '条目不存在' })
    const { content, reasoning, tool_calls } = req.body as { content?: string | null; reasoning?: string; tool_calls?: ToolCall[] }
    if (content === undefined && reasoning === undefined && tool_calls === undefined) {
      return res.status(400).json({ error: 'no field to update' })
    }
    void withLock(s.id, async () => {
      if (content !== undefined) entry.content = typeof content === 'string' ? content : null
      if (reasoning !== undefined) entry.reasoning = reasoning || undefined
      if (tool_calls !== undefined) entry.tool_calls = tool_calls
      saveSession(s)
      res.json({ entry, contextTokens: contextTokens(s.history) })
    })
  })

  app.delete('/api/sessions/:id/messages/:eid', (req, res) => {
    const s = guardSession(req, res)
    if (!s) return
    if (gens.has(s.id)) return res.status(409).json({ error: '会话正在生成中' })
    if (!s.history.some((e) => e.id === req.params.eid)) return res.status(404).json({ error: '条目不存在' })
    void withLock(s.id, async () => {
      const remaining = applyDelete(s, [req.params.eid])
      if (!remaining) return res.status(400).json({ error: '删除后会话将以助手回复开头，无法继续对话' })
      saveSession(s)
      res.json({ history: remaining, contextTokens: contextTokens(remaining) })
    })
  })

  // 批量删除：body { ids: string[] }，级联规则与单条删除一致
  app.delete('/api/sessions/:id/messages', (req, res) => {
    const s = guardSession(req, res)
    if (!s) return
    if (gens.has(s.id)) return res.status(409).json({ error: '会话正在生成中' })
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
    if (!ids.length || !s.history.some((e) => ids.includes(e.id))) return res.status(404).json({ error: '条目不存在' })
    void withLock(s.id, async () => {
      const remaining = applyDelete(s, ids)
      if (!remaining) return res.status(400).json({ error: '删除后会话将以助手回复开头，无法继续对话' })
      saveSession(s)
      res.json({ history: remaining, contextTokens: contextTokens(remaining) })
    })
  })

  // ===== 模型扫描（OpenAI 兼容 /models） =====
  app.get('/api/models', async (req, res) => {
    const base = typeof req.query.base === 'string' ? req.query.base : ''
    if (!base) {
      return res.status(400).json({ error: 'base required' })
    }
    const key = typeof req.query.key === 'string' ? req.query.key : ''
    try {
      const data = await getOpenAI(base, key).models.list()
      res.json({ models: data.data.map((m) => m.id) })
    } catch (err) {
      res.status(502).json({ error: errMsg(err) })
    }
  })

  // ===== MCP 管理（状态查询 / 手动重连） =====
  app.get('/api/mcp', (_req, res) => {
    res.json({ servers: mcpStatus() })
  })

  app.post('/api/mcp/sync', (_req, res) => {
    void syncMcp().then(() => {
      res.json({ servers: mcpStatus() })
    })
  })
}