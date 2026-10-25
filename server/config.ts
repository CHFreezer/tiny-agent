import path from 'node:path'
import fs from 'node:fs'
import type { McpServerConfig, Settings } from './types.ts'
import { fsErrorText } from './fsError.ts'

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ===== 服务器配置 =====
// 数据目录：--data-dir 参数显式指定（npm run dev:server -- --data-dir <路径>）；缺省 ./data（相对进程 cwd）
const dataDirArg = (() => {
  const i = process.argv.indexOf('--data-dir')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
export const DATA_DIR = dataDirArg ? path.resolve(dataDirArg) : path.join(process.cwd(), 'data')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
// 监听端口优先级：--port 参数（npm run dev:server -- --port <端口>）> 环境变量 PORT > 3000；非法值一律回退缺省，避免 listen 抛错
const portOf = (v: string | undefined) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}
const portArg = (() => {
  const i = process.argv.indexOf('--port')
  if (i < 0) return undefined
  if (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--')) {
    console.error('[server] --port 需要一个端口参数')
    process.exit(1)
  }
  return portOf(process.argv[i + 1])
})()
export const PORT = portArg ?? portOf(process.env.PORT) ?? 3000
fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true })
// 工具工作区：pwsh 工作目录 + read_image 相对路径基准；模型相对文件操作落在这里；内置工具的 %TEMP% 统一重定向到其 tmp/
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')
fs.mkdirSync(path.join(WORKSPACE_DIR, 'tmp'), { recursive: true })

// 工具级 cwd 覆盖：相对路径基于 workspace；省略/空 = workspace；必须是已存在目录
export function resolveCwd(input: unknown): { dir: string } | { error: string } {
  const raw = input === undefined || input === null ? '' : String(input).trim()
  if (!raw) return { dir: WORKSPACE_DIR }
  const abs = path.resolve(WORKSPACE_DIR, raw)
  try {
    if (!fs.statSync(abs).isDirectory()) return { error: `cwd 不是目录: ${abs}` }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { error: code === 'ENOENT' ? `cwd 不存在: ${abs}` : `cwd 不可用: ${fsErrorText(err, abs)}` }
  }
  return { dir: abs }
}

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

// MCP 环境变量：新格式是键值对象；旧配置是 "K=V;K2=V2" 字符串，读取时统一归一化。
// 键不允许空白/= 等会被误解析的字符；值保持原样（仅限字符串，限长、限量）。
export function normalizeEnv(v: unknown): Record<string, string> {
  if (typeof v === 'string') {
    const out: Record<string, string> = {}
    for (const part of v.split(';')) {
      const i = part.indexOf('=')
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    return out
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string' || !k.trim() || /[\s=]/.test(k)) continue
    out[k.trim().slice(0, 256)] = val.slice(0, 4096)
    if (Object.keys(out).length >= 64) break
  }
  return out
}

export function readSettings(): Settings {
  const def: Settings = { baseUrl: '', mode: 'openai', model: '', effort: '', apiKey: '', mcp: [], maxContext: 0, maxTokens: 0, headers: {}, pwsh: false }
  try {
    const s = { ...def, ...(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>) }
    s.mcp = (Array.isArray(s.mcp) ? s.mcp : [])
      .filter((c): c is McpServerConfig => !!c && typeof c.name === 'string' && typeof c.command === 'string')
      .map((c) => ({ ...c, env: normalizeEnv(c.env), enabled: c.enabled !== false }))
    // 请求头：只保留字符串键值（防止手改 settings.json 塞入非法结构）
    s.headers = s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)
      ? Object.fromEntries(Object.entries(s.headers).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
      : {}
    s.pwsh = s.pwsh === true // 默认关闭：只有显式 true 才启用
    return s
  } catch {
    return def
  }
}