import express from 'express'
import OpenAI from 'openai'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFile, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
const PORT = Number(process.env.PORT) || 3000

// ===== 类型（服务器是会话状态的唯一所有者；浏览器只发指令、收事件） =====
interface ToolCall {
  id: string
  name: string
  arguments: string
}
interface Entry {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool' | 'summary'
  content: string | null
  reasoning?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  images?: string[]
  summaryStatus?: 'failed' // 压缩摘要生成失败（截断/报错）：不是有效分割点
  ts?: number // 创建时间（毫秒），前端显示相对时间
}
interface Session {
  id: number
  title: string
  history: Entry[]
  createdAt: number
}
interface McpServerConfig {
  name: string
  command: string
  args: string
  env: string
  enabled: boolean // 工具是否加入模型上下文（false=不连接、不出现在工具集）
}
interface Settings {
  baseUrl: string
  mode: string
  model: string
  effort: string
  apiKey: string
  mcp: McpServerConfig[]
  maxContext: number // 最大上下文窗口 token，0=不限
  maxTokens: number // 最大输出 token，0=模型默认
  pwsh: boolean // pwsh 工具开关（是否下发给模型）
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ===== 服务器配置 =====
// 数据目录：--data-dir 参数显式指定（npm run dev:server -- --data-dir <路径>）；缺省 ./data（相对进程 cwd）
const dataDirArg = (() => {
  const i = process.argv.indexOf('--data-dir')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const DATA_DIR = dataDirArg ? path.resolve(dataDirArg) : path.join(process.cwd(), 'data')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true })
// 工具工作区：pwsh 工作目录 + read_image 相对路径基准；模型相对文件操作落在这里；内置工具的 %TEMP% 统一重定向到其 tmp/
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')
fs.mkdirSync(path.join(WORKSPACE_DIR, 'tmp'), { recursive: true })

// 崩溃观测：未捕获异常/未处理 rejection 写盘（dev 进程退出后控制台日志会丢）
const CRASH_LOG = path.join(DATA_DIR, 'crash.log')
const logCrash = (kind: string, err: unknown) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(CRASH_LOG, `\n[${new Date().toISOString()}] ${kind}\n${err instanceof Error ? err.stack || err.message : String(err)}\n`)
  } catch {
    // 日志失败不影响崩溃流程
  }
}
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
  console.error('[crash] uncaughtException', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason)
  console.error('[crash] unhandledRejection', reason)
  process.exit(1)
})

function readSettings(): Settings {
  const def: Settings = { baseUrl: '', mode: 'openai', model: '', effort: '', apiKey: '', mcp: [], maxContext: 0, maxTokens: 0, pwsh: true }
  try {
    const s = { ...def, ...(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>) }
    s.mcp = (Array.isArray(s.mcp) ? s.mcp : [])
      .filter((c): c is McpServerConfig => !!c && typeof c.name === 'string' && typeof c.command === 'string')
      .map((c) => ({ ...c, enabled: c.enabled !== false }))
    s.pwsh = s.pwsh !== false
    return s
  } catch {
    return def
  }
}

const app = express()
app.use(express.json({ limit: '20mb' })) // 图片 base64 可能较大

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

// ===== 记忆：持久文本列表，每次生成注入 developer 角色 =====
const MEMORIES_FILE = path.join(DATA_DIR, 'memories.json')
function readMemories(): string[] {
  try {
    const a = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf8'))
    return Array.isArray(a) ? a.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : []
  } catch {
    return []
  }
}

app.get('/api/memories', (_req, res) => {
  res.json({ memories: readMemories() })
})

app.put('/api/memories', (req, res) => {
  const { memories } = req.body as { memories?: unknown }
  if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories required' })
  const clean = memories
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, 50)
    .map((m) => m.slice(0, 2000))
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(MEMORIES_FILE, JSON.stringify(clean))
  res.json({ memories: clean })
})
// ===== 会话存储：内存为权威 + 写穿到磁盘（每会话一个文件，_index.json 存 currentId） =====
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const SESSIONS_INDEX = path.join(SESSIONS_DIR, '_index.json')

// 一次性迁移：旧版单文件 sessions.json → 分文件
function migrateLegacySessions(): void {
  const legacy = path.join(DATA_DIR, 'sessions.json')
  try {
    if (!fs.existsSync(legacy)) return
    const { sessions = [], currentId = null } = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
      sessions?: Session[]
      currentId?: number | null
    }
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    for (const s of sessions) {
      fs.writeFileSync(path.join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify({ ...s, createdAt: s.createdAt || Date.now() }))
    }
    fs.writeFileSync(SESSIONS_INDEX, JSON.stringify({ currentId }))
    fs.unlinkSync(legacy)
  } catch {
    // 旧文件不存在或损坏：忽略
  }
}

const sessions = new Map<number, Session>()
let currentId: number | null = null

function loadAll(): void {
  migrateLegacySessions()
  sessions.clear()
  try {
    currentId = (JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')) as { currentId?: number | null }).currentId ?? null
  } catch {
    currentId = null
  }
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json') || f === '_index.json') continue
      try {
        sessions.set(+f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')) as Session)
      } catch {
        // 跳过损坏文件
      }
    }
  } catch {
    // 会话目录不存在
  }
}

function saveSession(s: Session): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.writeFileSync(path.join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify(s))
}

function saveIndex(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.writeFileSync(SESSIONS_INDEX, JSON.stringify({ currentId }))
}

function listSorted(): Session[] {
  return [...sessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

// 同一会话的任何变更（含在途生成）串行化
const locks = new Map<number, Promise<unknown>>()
function withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  locks.set(id, run.catch(() => {}))
  return run
}

// ===== 上游（100% OpenAI 标准，官方 SDK） =====
const clients = new Map<string, OpenAI>()
function getOpenAI(base: string, apiKey = ''): OpenAI {
  const key = `${base}::${apiKey}`
  let c = clients.get(key)
  if (!c) {
    c = new OpenAI({ baseURL: base, apiKey: apiKey || 'not-needed' })
    clients.set(key, c)
  }
  return c
}

// 消息规范化：OpenAI 客户端在 content 为 null 且带 tool_calls 时按空串序列化，
// 部分后端（vLLM/llama.cpp 等）不接受 assistant 空内容 → 补 ""
const normalizeMessage = (m: unknown): Record<string, unknown> => {
  const o = { ...(m as Record<string, unknown>) }
  if (o.role === 'assistant' && o.tool_calls && o.content == null) o.content = ''
  return o
}

// 内置工具（OpenAI function calling 格式）
const PWSH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'pwsh',
    description: `在本地机器上执行 PowerShell 命令并返回输出，可用于系统查询、文件操作等。工作目录：${WORKSPACE_DIR}（相对路径文件操作落在这里）`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
      },
      required: ['command'],
    },
  },
}
const READ_IMAGE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_image',
    description: `读取本机图片文件（png/jpg/webp/gif）并让模型看到图片内容。配合 playwright 截图使用：截图保存到磁盘后，用此工具读取截图路径。工作目录：${WORKSPACE_DIR}`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `图片文件路径（相对路径基于工作目录 ${WORKSPACE_DIR}）` },
      },
      required: ['path'],
    },
  },
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

function toApiMessages(history: Entry[]) {
  const mapEntry = (m: Entry): Record<string, unknown>[] => {
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
      // reasoning_content 回喂：让模型看到上一轮推理过程（思考连续性）；
      // 历史条目一旦生成即稳定，前缀一致不破坏 prompt cache；不认该字段的服务器忽略
      if (m.reasoning) e.reasoning_content = m.reasoning
      return [e]
    }
    if (m.role === 'tool') {
      const out: Record<string, unknown>[] = [{ role: 'tool', tool_call_id: m.tool_call_id, content: m.content }]
      // 带图工具结果（read_image）：tool 消息只能是文本，图片以紧随的 user 消息注入
      if (m.images?.length) {
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: '以下是读取的图片：' }]
        for (const url of m.images) content.push({ type: 'image_url', image_url: { url } })
        out.push({ role: 'user', content })
      }
      return out
    }
    if (m.role === 'assistant' && m.reasoning) {
      return [{ role: 'assistant', content: m.content, reasoning_content: m.reasoning }]
    }
    if (m.role === 'user' && m.images?.length) {
      const content: Array<Record<string, unknown>> = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const url of m.images) content.push({ type: 'image_url', image_url: { url } })
      return [{ role: 'user', content }]
    }
    return [{ role: m.role, content: m.content }]
  }
  let sumIdx = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'summary' && !history[i].summaryStatus) {
      sumIdx = i
      break
    }
  }
  if (sumIdx < 0) {
    return sanitizeToolCalls(history.filter((m) => !(m.role === 'system' && !m.content?.trim())).flatMap(mapEntry))
  }
  const msgs: Record<string, unknown>[] = []
  for (const m of history.slice(0, sumIdx)) {
    if (m.role === 'system' && m.content?.trim()) msgs.push({ role: 'system', content: m.content })
  }
  msgs.push({ role: 'user', content: 'What did we do so far?' })
  msgs.push({ role: 'assistant', content: history[sumIdx].content ?? '' })
  for (const m of history.slice(sumIdx + 1)) msgs.push(...mapEntry(m))
  msgs.push({ role: 'system', content: '从这里继续调用工具或者给出答案' })
  return sanitizeToolCalls(msgs)
}

// 当前实际将发送给模型的上下文 token 数（含 developer 记忆注入）
const contextTokens = (history: Entry[]) => {
  const memories = readMemories()
  const messages = memories.length
    ? [{ role: 'developer', content: memories.join('\n') }, ...toApiMessages(history)]
    : toApiMessages(history)
  return messages.reduce((a, m) => a + messageTokens(m), 0)
}

// ===== 上下文窗口管理：token 估算（压缩触发/超窗检测用） =====
// 估算：CJK 字符 ≈ 1 token，其他 ≈ 4 字符 1 token（无分词器的工程近似）
const countTextTokens = (text: string) => {
  let cjk = 0
  let other = 0
  for (const ch of text) (ch.codePointAt(0)! > 0x2e7f ? cjk++ : other++)
  return cjk + Math.ceil(other / 4)
}
const messageTokens = (m: Record<string, unknown>) => {
  let n = 4 // 每条消息的固定开销
  if (typeof m.content === 'string') n += countTextTokens(m.content)
  if (Array.isArray(m.content)) for (const p of m.content) if (p && p.type === 'text' && typeof p.text === 'string') n += countTextTokens(p.text)
  if (Array.isArray(m.tool_calls)) n += countTextTokens(JSON.stringify(m.tool_calls))
  if (typeof m.reasoning_content === 'string') n += countTextTokens(m.reasoning_content)
  return n
}

// ===== MCP（官方 SDK，stdio 传输）：服务器持有连接，工具并入生成循环 =====
// 工具名加前缀 mcp__<server>__<tool>，避免与内置工具/其他 MCP 服务器冲突
const MCP_CONNECT_TIMEOUT = 20000 // 首次 npx 拉包较慢
const MCP_TOOL_TIMEOUT = 30000

interface McpEntry {
  cfg: McpServerConfig
  client?: Client
  transport?: StdioClientTransport
  tools: McpTool[]
  status: 'connecting' | 'ok' | 'error'
  error?: string
}
const mcpServers = new Map<string, McpEntry>()
const mcpToolMap = new Map<string, { entry: McpEntry; tool: McpTool }>()

// MCP 插件工作目录：插件的相对写入（截图/日志/临时文件）收拢到数据目录；TEMP 重定向到其 tmp/；启动时清扫过期文件
const MCP_DATA_DIR = path.join(DATA_DIR, 'mcp')
const MCP_SWEEP_DAYS = 7
function mcpWorkdir(name: string): string {
  const d = path.join(MCP_DATA_DIR, mcpSanitize(name))
  fs.mkdirSync(path.join(d, 'tmp'), { recursive: true })
  return d
}
function sweepWorkspace(): void {
  try {
    const cutoff = Date.now() - MCP_SWEEP_DAYS * 86400000
    const walk = (dir: string) => {
      for (const st of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, st.name)
        if (st.isDirectory()) {
          walk(p)
          try { fs.rmdirSync(p) } catch { /* 非空目录保留 */ }
        } else {
          try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p) } catch { /* 忽略 */ }
        }
      }
    }
    for (const dir of [WORKSPACE_DIR, MCP_DATA_DIR]) {
      if (fs.existsSync(dir)) walk(dir)
    }
  } catch {
    // 清扫失败不影响启动
  }
}

// 关闭连接并杀掉整个进程树（npx 的孙进程不随父进程死亡，Windows 下必须 /T）
async function closeMcpEntry(e: McpEntry): Promise<void> {
  const pid = (e.transport as unknown as { subprocess?: { pid?: number } } | undefined)?.subprocess?.pid
  if (pid && process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' })
    } catch {
      // 进程已退出
    }
  }
  try {
    await e.transport?.close()
  } catch {
    // 忽略
  }
  e.tools = []
}

const mcpSanitize = (s: string) => (s.replace(/[^a-zA-Z0-9_-]/g, '_') || 'srv').slice(0, 48)
const mcpToolName = (server: string, tool: string) =>
  ('mcp__' + mcpSanitize(server) + '__' + tool.replace(/[^a-zA-Z0-9_-]/g, '_')).slice(0, 64)

function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of s.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function rebuildMcpToolMap(): void {
  mcpToolMap.clear()
  for (const e of mcpServers.values()) {
    if (e.status !== 'ok') continue
    for (const t of e.tools) mcpToolMap.set(mcpToolName(e.cfg.name, t.name), { entry: e, tool: t })
  }
}

function mcpTools(): OpenAI.Chat.ChatCompletionTool[] {
  const out: OpenAI.Chat.ChatCompletionTool[] = []
  for (const { entry, tool } of mcpToolMap.values()) {
    out.push({
      type: 'function',
      function: {
        name: mcpToolName(entry.cfg.name, tool.name),
        description: tool.description ?? `MCP 工具 ${entry.cfg.name}/${tool.name}`,
        parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      },
    })
  }
  return out
}

export function mcpStatus(): Array<{ name: string; command: string; status: string; error?: string; tools: string[] }> {
  return [...mcpServers.values()].map((e) => ({
    name: e.cfg.name,
    command: e.cfg.command,
    status: e.status,
    ...(e.error ? { error: e.error.slice(0, 300) } : {}),
    tools: e.tools.map((t) => t.name),
  }))
}

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms)
    p.then((v) => {
      clearTimeout(t)
      resolve(v)
    }, (e) => {
      clearTimeout(t)
      reject(e)
    })
  })

// 按当前设置对齐连接：删掉的关闭、变更的重连；幂等可重入
let mcpSyncing: Promise<void> | null = null
export function syncMcp(): Promise<void> {
  if (mcpSyncing) return mcpSyncing
  mcpSyncing = (async () => {
    const want = new Map(readSettings().mcp.filter((c) => c.enabled).map((c) => [c.name, c]))
    for (const [name, e] of [...mcpServers]) {
      if (!want.has(name)) {
        mcpServers.delete(name)
        await closeMcpEntry(e)
      }
    }
    rebuildMcpToolMap()
    await Promise.allSettled(
      [...want.values()].map(async (cfg) => {
        const old = mcpServers.get(cfg.name)
        if (old) await closeMcpEntry(old)
        const e: McpEntry = { cfg, tools: [], status: 'connecting' }
        mcpServers.set(cfg.name, e)
        try {
          const workdir = mcpWorkdir(cfg.name)
          const transport = new StdioClientTransport({
            command: cfg.command,
            args: splitArgs(cfg.args),
            cwd: workdir,
            // TEMP 重定向到插件工作目录（用户配置的 env 可覆盖）
            env: Object.fromEntries(Object.entries({ ...process.env, TEMP: path.join(workdir, 'tmp'), TMP: path.join(workdir, 'tmp'), TMPDIR: path.join(workdir, 'tmp'), ...parseEnv(cfg.env) }).filter((v): v is [string, string] => v[1] !== undefined)),
            stderr: 'pipe',
          })
          e.transport = transport // 先登记：连接失败也能按进程树清理
          const client = new Client({ name: 'tiny-agent', version: '1.0.0' })
          await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT, 'MCP 连接')
          e.client = client
          client.onclose = () => {
            if (mcpServers.get(cfg.name) === e) {
              e.status = 'error'
              e.error = '连接已断开'
              void closeMcpEntry(e)
              rebuildMcpToolMap()
            }
          }
          const { tools } = await withTimeout(client.listTools(), MCP_CONNECT_TIMEOUT, 'MCP 工具列表')
          e.tools = tools
          e.status = 'ok'
          rebuildMcpToolMap()
        } catch (err) {
          e.status = 'error'
          e.error = errMsg(err)
          await closeMcpEntry(e) // 连接失败：杀掉已拉起的子进程树
          rebuildMcpToolMap()
        }
      }),
    )
    mcpSyncing = null
  })()
  return mcpSyncing
}

// ===== 工具执行（服务器侧） =====
// PowerShell 可执行文件：优先 pwsh（PowerShell 7），回退 powershell（Windows PowerShell）
let PS_BIN = 'powershell'
try {
  execSync('where pwsh', { windowsHide: true, stdio: 'ignore' })
  PS_BIN = 'pwsh'
} catch {
  // 未安装 pwsh
}

function runPwsh(command: string, signal: AbortSignal) {
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; output: string }>()
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  execFile(
    PS_BIN,
    ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`],
    { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, cwd: WORKSPACE_DIR, env: { ...process.env, NO_COLOR: '1', TEMP: path.join(WORKSPACE_DIR, 'tmp'), TMP: path.join(WORKSPACE_DIR, 'tmp'), TMPDIR: path.join(WORKSPACE_DIR, 'tmp') }, signal },
    (err, stdout, stderr) => {
      if (signal.aborted) {
        reject(err ?? new Error('aborted'))
        return
      }
      const parts: string[] = []
      if (stdout?.trim()) parts.push(stdout.trim())
      if (stderr?.trim()) parts.push(stderr.trim())
      const output = stripAnsi(parts.join('\n')) || (err ? String(err.message) : '(无输出)')
      resolve({ exitCode: typeof err?.code === 'number' ? err.code : 0, output: output.slice(0, 8000) })
    },
  )
  return promise
}
interface ToolResult {
  text: string
  images?: string[] // data URL：随工具结果注入上下文，让模型看到图片（read_image）
}
async function executeTool(tc: ToolCall, signal: AbortSignal): Promise<ToolResult> {
  if (tc.name === 'read_image') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      const p = String(args.path ?? '')
      const abs = path.resolve(WORKSPACE_DIR, p)
      const st = fs.statSync(abs)
      if (!st.isFile()) throw new Error('不是文件')
      if (st.size > 20 * 1024 * 1024) throw new Error('图片过大（上限 20MB）')
      const ext = path.extname(abs).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png'
      const dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
      return { text: `已读取图片 ${abs}（${st.size} 字节），图片内容已加入上下文`, images: [dataUrl] }
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `读取图片失败: ${errMsg(err)}` }
    }
  }
  if (tc.name === 'pwsh') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      const r = await runPwsh(String(args.command ?? ''), signal)
      return { text: r.output }
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `工具执行失败: ${errMsg(err)}` }
    }
  }
  // MCP 工具：路由到对应服务器的连接（超时 + 用户停止信号）
  const m = mcpToolMap.get(tc.name)
  if (m?.entry.client) {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      const result = (await m.entry.client.callTool(
        { name: m.tool.name, arguments: args },
        undefined,
        { timeout: MCP_TOOL_TIMEOUT, signal },
      )) as CallToolResult
      const texts = (Array.isArray(result.content) ? result.content : [])
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
      const out = texts.join('\n') || '(无文本输出)'
      return { text: ((result.isError ? '(MCP 返回错误)\n' : '') + out).slice(0, 8000) }
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `MCP 工具执行失败: ${errMsg(err)}` }
    }
  }
  return { text: `未知工具: ${tc.name}` }
}

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

// 上游真实 token 用量（stream_options.include_usage 的末尾 chunk）
interface Usage {
  prompt: number
  completion: number
  total: number
}
const addUsage = (u: Usage, c?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null) => {
  if (!c) return
  u.prompt += c.prompt_tokens ?? 0
  u.completion += c.completion_tokens ?? 0
  u.total += c.total_tokens ?? 0
}
async function compactContext(session: Session, w: (o: unknown) => void, signal: AbortSignal, usage: Usage): Promise<void> {
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
    const messages = [
      ...toApiMessages(session.history.filter((e) => e.id !== entry.id)),
      { role: 'user', content: SUMMARY_PROMPT },
    ]
    const stream = await getOpenAI(s.baseUrl, s.apiKey).chat.completions.create(
      {
        model: s.model,
        messages: messages.map(normalizeMessage) as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 16384,
      },
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

async function generate(session: Session, w: (o: unknown) => void, finish: () => void, opts: GenerateOpts): Promise<void> {
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
      const allTools = [...(readSettings().pwsh ? [PWSH_TOOL] : []), READ_IMAGE_TOOL, ...mcpTools()]
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
      if (!failed) failed = '模型返回了空内容，请重试'
    }
    saveSession(session)
    if (failed) break
    // 气泡完成后检测压缩触发：已用 > 窗口 - max(20k, 最大输出)
    if (s.maxContext > 0 && contextTokens(session.history) > s.maxContext - Math.max(20000, s.maxTokens)) {
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
      if (s.maxContext > 0 && contextTokens(session.history) > s.maxContext - Math.max(20000, s.maxTokens)) {
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

// 生成端点公共骨架：会话校验 + 忙锁
function guardSession(req: express.Request, res: express.Response): Session | null {
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

// ===== 生成与连接解耦：生成独立于任何 HTTP 连接运行 =====
// 每个进行中的生成：事件缓冲（供新连接重放重建视图）+ 当前附加的响应集合
// 客户端断开只移除连接，不中断生成；停止走显式 POST /stop
interface Gen {
  controller: AbortController
  events: unknown[]
  clients: Set<express.Response>
}
const gens = new Map<number, Gen>()

const ndjsonHeaders = (res: express.Response) => {
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
}
const makeW = (g: Gen): ((o: unknown) => void) => (o) => {
  g.events.push(o)
  for (const r of g.clients) if (!r.destroyed) r.write(JSON.stringify(o) + '\n')
}
const endAll = (g: Gen) => {
  for (const r of [...g.clients]) if (!r.writableFinished) {
    try {
      r.end()
    } catch {
      // 已断开
    }
  }
}
// 附加一个响应：重放已缓冲事件（新连接据此重建完整视图），随后实时转发
function attachClient(g: Gen, res: express.Response) {
  ndjsonHeaders(res)
  g.clients.add(res)
  for (const e of g.events) res.write(JSON.stringify(e) + '\n')
  res.on('close', () => g.clients.delete(res))
}

// ===== 会话指令 =====
app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: listSorted().map((s) => ({ ...s, contextTokens: contextTokens(s.history), generating: gens.has(s.id) })), currentId })
})

app.post('/api/sessions', (_req, res) => {
  const s: Session = {
    id: Date.now(),
    title: '新会话',
    history: [{ id: randomUUID(), role: 'system', content: 'You are a helpful assistant.', ts: Date.now() }],
    createdAt: Date.now(),
  }
  sessions.set(s.id, s)
  saveSession(s)
  currentId = s.id
  saveIndex()
  res.json({ session: s, currentId })
})

app.post('/api/sessions/:id/switch', (req, res) => {
  const id = Number(req.params.id)
  if (!sessions.has(id)) return res.status(404).json({ error: '会话不存在' })
  currentId = id
  saveIndex()
  res.json({ currentId })
})

app.put('/api/sessions/:id', (req, res) => {
  const id = Number(req.params.id)
  const s = sessions.get(id)
  if (!s) return res.status(404).json({ error: '会话不存在' })
  const { title } = req.body as { title?: string }
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' })
  s.title = title.trim().slice(0, 40)
  saveSession(s)
  res.json({ session: s })
})

app.delete('/api/sessions/:id', (req, res) => {
  const id = Number(req.params.id)
  const s = sessions.get(id)
  if (!s) return res.status(404).json({ error: '会话不存在' })
  if (gens.has(id)) return res.status(409).json({ error: '会话正在生成中' })
  sessions.delete(id)
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${id}.json`))
  } catch {
    // 文件不存在
  }
  if (currentId === id) {
    const rest = listSorted()
    currentId = rest.length ? rest[0].id : null
  }
  saveIndex()
  res.json({ sessions: listSorted(), currentId })
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

// 工具调用/工具结果成对绑定：删调用气泡连带删其工具结果（结果可能暂未生成，找不到即可）；删工具结果连带删发出该调用的气泡
function cascadeDrop(history: Entry[], entry: Entry, drop: Set<string>): void {
  drop.add(entry.id)
  if (entry.role === 'assistant' && entry.tool_calls?.length) {
    const ids = new Set(entry.tool_calls.map((tc) => tc.id))
    for (const e of history) if (e.role === 'tool' && e.tool_call_id && ids.has(e.tool_call_id)) drop.add(e.id)
  } else if (entry.role === 'tool' && entry.tool_call_id) {
    for (const e of history) if (e.role === 'assistant' && e.tool_calls?.some((tc) => tc.id === entry.tool_call_id)) drop.add(e.id)
  }
}
// 气泡被连带删除后，其余工具结果成为孤儿（tool 消息必须配对 tool_calls，否则上游 400），一并清除
function dropOrphanedTools(history: Entry[], drop: Set<string>): void {
  for (const e of history) {
    if (e.role === 'tool' && e.tool_call_id && !drop.has(e.id)) {
      const parent = history.find((p) => p.role === 'assistant' && p.tool_calls?.some((tc) => tc.id === e.tool_call_id))
      if (!parent || drop.has(parent.id)) drop.add(e.id)
    }
  }
}
// 删除条目（单条/批量共用）：级联 + 孤儿清理；返回 null 表示删除后会话以助手回复开头（上游拒绝首条非 user/system 消息），拒绝执行
function applyDelete(s: Session, ids: string[]): Entry[] | null {
  const drop = new Set<string>()
  for (const id of ids) {
    const entry = s.history.find((e) => e.id === id)
    if (entry) cascadeDrop(s.history, entry, drop)
  }
  dropOrphanedTools(s.history, drop)
  const remaining = s.history.filter((e) => !drop.has(e.id))
  for (const e of remaining) {
    if (e.role !== 'system') {
      if (e.role === 'assistant') return null
      break
    }
  }
  s.history = remaining
  return remaining
}

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

// ===== TTS（pwsh 7 + System.Speech 10，本地 Xiaoxiao 音色，合成 wav 返回浏览器播放） =====
const PWSH7 = (() => {
  try {
    const p = execSync('where pwsh', { windowsHide: true, stdio: 'ignore' }).toString().split(/\r?\n/)[0].trim()
    if (p) return p
  } catch {
    // 不在 PATH
  }
  const fallback = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  return fs.existsSync(fallback) ? fallback : ''
})()

// 固定缓存文件：同文本反复播放直接复用，不重新合成；不同文本重新合成覆盖
const TTS_WAV = path.join(DATA_DIR, 'tts.wav')
let ttsCacheText: string | null = null
let ttsGen = 0

function streamWav(res: express.Response, file: string): void {
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Content-Length', fs.statSync(file).size)
  fs.createReadStream(file).pipe(res)
}

app.post('/api/tts', (req, res) => {
  const { text } = req.body as { text?: string }
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' })
  if (!PWSH7) return res.status(500).json({ error: '未找到 pwsh 7（TTS 需要）' })
  const body = text.slice(0, 8000)
  if (ttsCacheText === body && fs.existsSync(TTS_WAV)) {
    streamWav(res, TTS_WAV)
    return
  }
  const gen = ++ttsGen
  const textFile = path.join(os.tmpdir(), `tts-${randomUUID()}.txt`)
  fs.writeFileSync(textFile, body, 'utf8')
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts.ps1')
  execFile(PWSH7, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, TTS_WAV, textFile], { timeout: 90000 }, (err) => {
    try {
      fs.unlinkSync(textFile)
    } catch {
      // 忽略
    }
    if (gen !== ttsGen) {
      // 已被更新的合成请求取代（客户端单实例会 abort 旧请求）
      if (!res.headersSent) res.status(409).json({ error: '已被新的朗读请求取代' })
      return
    }
    if (err || !fs.existsSync(TTS_WAV)) {
      if (!res.headersSent) res.status(500).json({ error: errMsg(err) || 'TTS 合成失败' })
      return
    }
    ttsCacheText = body
    streamWav(res, TTS_WAV)
  })
})

// ===== 静态托管 =====
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

sweepWorkspace() // 启动时清扫工具工作区的过期文件
loadAll()
void syncMcp() // 启动时按持久化配置连接 MCP 服务器

const shutdownMcp = () => {
  void Promise.allSettled([...mcpServers.values()].map((e) => closeMcpEntry(e))).then(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdownMcp)
process.on('SIGTERM', shutdownMcp)

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] http://127.0.0.1:${PORT}`)
})
