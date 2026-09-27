import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import OpenAI from 'openai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { WORKSPACE_DIR, errMsg, readSettings } from './config.ts'
import type { McpServerConfig } from './types.ts'

// ===== MCP（官方 SDK，stdio 传输）：服务器持有连接，工具并入生成循环 =====
// 工具名加前缀 mcp__<server>__<tool>，避免与内置工具/其他 MCP 服务器冲突
const MCP_CONNECT_TIMEOUT = 20000 // 首次 npx 拉包较慢
export const MCP_TOOL_TIMEOUT = 30000

export interface McpEntry {
  cfg: McpServerConfig
  client?: Client
  transport?: StdioClientTransport
  tools: McpTool[]
  status: 'connecting' | 'ok' | 'error'
  error?: string
}
const mcpServers = new Map<string, McpEntry>()
export const mcpToolMap = new Map<string, { entry: McpEntry; tool: McpTool }>()

// MCP 插件工作目录：与内置工具（pwsh/read_image）共用 WORKSPACE_DIR，
// 各工具产生的文件互相可见；TEMP 重定向到其 tmp/；启动时清扫过期文件
const MCP_SWEEP_DAYS = 7
export function sweepWorkspace(): void {
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
    if (fs.existsSync(WORKSPACE_DIR)) walk(WORKSPACE_DIR)
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

// 关闭全部连接（进程退出前）
export async function closeAllMcp(): Promise<void> {
  await Promise.allSettled([...mcpServers.values()].map((e) => closeMcpEntry(e)))
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

export function mcpTools(): OpenAI.Chat.ChatCompletionTool[] {
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
          const workdir = WORKSPACE_DIR
          const transport = new StdioClientTransport({
            command: cfg.command,
            args: splitArgs(cfg.args),
            cwd: workdir,
            // TEMP 重定向到共享工作区（用户配置的 env 可覆盖）
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