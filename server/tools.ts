import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createLiveDecoder, decodeOutput } from './encoding.ts'
import OpenAI from 'openai'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { WORKSPACE_DIR, errMsg, readSettings, resolveCwd } from './config.ts'
import { MCP_TOOL_TIMEOUT, mcpToolMap, mcpTools } from './mcp.ts'
import { editTool, readTool, writeTool } from './files.ts'
import { searchTool } from './search.ts'
import { clipMiddle } from './text.ts'
import { EDIT_ARGS, PWSH_ARGS, READ_ARGS, READ_IMAGE_ARGS, SEARCH_ARGS, WRITE_ARGS, validateArgs, validateMcpArgs } from './toolArgs.ts'
import { fsErrorText } from './fsError.ts'
import type { ToolCall, ToolResult } from './types.ts'

// 内置工具（OpenAI function calling 格式）
const READ_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read',
    description: `读取文件。encoding 默认 "utf-8"；encoding:"hex" 为十六进制模式（地址 + 16 字节/行 + ASCII）。
- 文本：line = 起始行（1-based，默认 1），limit = 行数（默认/上限 2000）；输出 cat -n 风格（行号右对齐 + Tab）
- 文本末尾：tail = 最后 N 行（1-2000，不输出行号；与 line/limit 互斥）
- hex：offset = 字节偏移（0-based，支持 0x，默认 0），bytes = 字节数（默认 1024，上限 4096）
编码支持 iconv-lite 标签。路径相对 cwd（默认 workspace 根目录，也支持绝对路径）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        encoding: { type: 'string', description: '文本编码（默认 utf-8）或 "hex"' },
        line: { type: 'number', description: '文本：起始行（1-based，默认 1）' },
        offset: { type: ['number', 'string'], description: 'hex：字节偏移（0-based，支持 0x，默认 0）' },
        limit: { type: 'number', description: '文本：行数（默认/上限 2000）' },
        bytes: { type: 'number', description: 'hex：字节数（默认 1024，上限 4096）' },
        tail: { type: 'number', description: '文本：从末尾读取的行数（1-2000，不输出行号，与 line/limit 互斥）' },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
      },
      required: ['path'],
    },
  },
}
const EDIT_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'edit',
    description: `修改现有文件。
文本：old 空/省略=插入（无 line 仅空文件；有 line 插到该行行首，new 需自带换行；行数+1=末尾，仅当文件以换行结尾）；否则替换 old，new 空=删除；多处默认修改第一处，replace_all 全部；old/new 按字节精确匹配。
hex：offset 必填，old/new 为十六进制字节；old 空=插入，new 空=删除；replace_all、line 不可用。
路径相对 cwd（默认 workspace 根目录）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old: { type: 'string', description: '原文；空/省略=插入' },
        new: { type: 'string', description: '替换内容；空=删除' },
        encoding: { type: 'string', description: '文本编码（默认 utf-8）或 "hex"' },
        replace_all: { type: 'boolean', description: '全部匹配替换' },
        line: { type: 'number', description: '插入行号或查找起点（1-based）' },
        offset: { type: ['number', 'string'], description: 'hex：字节偏移（0-based，支持 0x）' },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
      },
      required: ['path', 'new'],
    },
  },
}
const WRITE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'write',
    description: `创建文件或整体覆盖已有文件，自动建父目录。
- content：内容；encoding 默认 "utf-8"，encoding:"hex" 时为十六进制字节
- overwrite：目标已存在时是否整体覆盖（默认 false，会报错）；覆盖会附带 diff
路径相对 cwd（默认 workspace 根目录，也支持绝对路径）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '内容；hex 模式为十六进制字节' },
        encoding: { type: 'string', description: '文本编码（默认 utf-8）或 "hex"' },
        overwrite: { type: 'boolean', description: '目标已存在时整体覆盖（默认 false）' },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
      },
      required: ['path', 'content'],
    },
  },
}
const SEARCH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'search',
    description: `在目录或单个文件中搜索文本。path 相对 cwd（默认 workspace，也支持绝对路径），可以是目录或文件；文件名命中也会作为结果返回。
mode：literal（默认，按字面量匹配，元字符不生效）或 regex（正则表达式，支持 lookaround）。
flags：可选组合字符串：
- i = 忽略大小写
- w = 全词匹配
- max_results：最多结果数（默认 100，上限 1000），达到后立即停止
- timeout：超时秒数（默认 30，最大 600）
- context：命中前后各显示 N 行上下文（默认 0，上限 20；上下文不计入结果数）
- encoding：文件编码（默认自动/UTF-8）
- include：只搜索匹配这些 glob 的文件（任意层级用 **/ 前缀）
- exclude：追加排除的 glob（不以 ** 或 / 开头的模式锚定搜索根；任意层级用 **/ 前缀）；默认遵循 .gitignore（即使不在 git 仓库内）`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索文本；默认按字面量，mode:"regex" 时按正则解释' },
        mode: { type: 'string', enum: ['literal', 'regex'], description: '匹配模式：literal（默认）或 regex' },
        flags: { type: 'string', description: '可选组合：i=忽略大小写，w=全词匹配' },
        path: { type: 'string', description: '搜索路径：目录或文件（相对 cwd，默认 .）' },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
        max_results: { type: 'number', description: '最多结果数（默认 100，上限 1000）' },
        timeout: { type: 'number', description: '超时秒数（默认 30，最大 600）' },
        context: { type: 'number', description: '命中前后各显示 N 行上下文（默认 0，上限 20）' },
        encoding: { type: 'string', description: '文件编码（默认自动/UTF-8）' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: '只搜索匹配这些 glob 的文件（任意层级用 **/ 前缀）',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: '追加排除的 glob（不以 ** 或 / 开头的模式锚定搜索根；任意层级用 **/ 前缀）；默认遵循 .gitignore',
        },
      },
      required: ['pattern'],
    },
  },
}
const PWSH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'pwsh',
    description: `在本地执行 PowerShell 7（pwsh.exe）命令并返回输出，用于构建、测试、安装、系统查询、运行脚本等。cwd 可覆盖工作目录（必须是已存在目录；默认 workspace 根目录）。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeout: { type: 'number', description: '超时秒数，默认 30，最大 600' },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
      },
      required: ['command'],
    },
  },
}
const READ_IMAGE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_image',
    description: `读取本机图片文件（png/jpg/webp/gif）并让模型看到图片内容。路径相对 cwd（默认 workspace 根目录，也支持绝对路径）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `图片文件路径（相对 cwd）` },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
      },
      required: ['path'],
    },
  },
}

// 当前工具集（与生成请求同源）：生成循环与压缩请求共用。
// 文件工具排在 pwsh 前面：模型对工具列表有位置偏好，且 pwsh 描述里已注明文件操作走内置工具。
export function currentTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [READ_TOOL, SEARCH_TOOL, EDIT_TOOL, WRITE_TOOL, READ_IMAGE_TOOL, ...(readSettings().pwsh ? [PWSH_TOOL] : []), ...mcpTools()]
}

// MCP 工具结果 → ToolResult：文本 + image content（如 Playwright 截图）转 data URL，
// 图片与 read_image 走同一条落盘/注入路径
export function formatMcpResult(result: CallToolResult): ToolResult {
  const parts = Array.isArray(result.content) ? result.content : []
  const texts = parts
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
  const images = parts
    .filter((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image')
    .map((c) => `data:${c.mimeType || 'image/png'};base64,${c.data}`)
  const out = texts.join('\n') || (images.length ? '(图片结果)' : '(无文本输出)')
  return {
    text: (result.isError ? '(MCP 返回错误)\n' : '') + clipMiddle(out, MCP_MAX_OUTPUT_CHARS),
    isError: result.isError === true,
    ...(images.length ? { images } : {}),
  }
}

// ===== 工具执行（服务器侧） =====
// 只支持 PowerShell 7（pwsh.exe）：脚本正文作为单个 argv 元素交给 -Command，不做任何注入（照 opencode shell.ts:293）
const PWSH_DEFAULT_TIMEOUT_S = 30
const PWSH_MAX_TIMEOUT_S = 600
const PWSH_MAX_CAPTURE_BYTES = 1024 * 1024 // 捕获窗口（滚动）：只留最新这么多字节，超出丢最旧的，不杀进程
const PWSH_MAX_OUTPUT_CHARS = 10000 // 交给模型的字符上限（头+尾）
const PWSH_LIVE_MAX_CHARS = 20000 // 实时回显上限：超过后停止实时推送（结束后仍有截断结果）
const PWSH_EXIT_GRACE_MS = 150 // 主进程退出后等待管道剩余数据的宽限期（'close' 可能永不触发）
const PWSH_KILL_GRACE_MS = 3000 // kill 后连 exit 都收不到时的强制收尾上限
const MCP_MAX_OUTPUT_CHARS = 8000 // MCP 文本结果上限（与 pwsh 同策略）

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
// 实时回显流：按行解码（UTF-8 / 本地代码页自动判定）；ANSI 转义序列可能被块边界截断，留到下一块
function liveTextStream(onText: (text: string) => void) {
  let pendingAnsi = ''
  const push = (s: string) => {
    let text = pendingAnsi + s
    pendingAnsi = ''
    const cut = /\x1b(?:\[[0-9;]*)?$/.exec(text)
    if (cut) {
      pendingAnsi = cut[0]
      text = text.slice(0, cut.index)
    }
    text = stripAnsi(text)
    if (text) onText(text)
  }
  const decoder = createLiveDecoder(push)
  return {
    write: (chunk: Buffer) => decoder.write(chunk),
    end: () => decoder.end(),
  }
}
// 实时回显合批：逐 chunk 推事件会把 NDJSON 撑成海量小包（40ms 一批 + 4KB 立即刷新）
function makeLiveEmitter(send: (text: string) => void) {
  let buf = ''
  let sent = 0
  let capped = false
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!buf) return
    const text = buf
    buf = ''
    sent += text.length
    send(text)
  }
  return {
    push(text: string) {
      if (capped || !text) return
      const room = PWSH_LIVE_MAX_CHARS - sent - buf.length
      if (text.length > room) {
        buf += text.slice(0, Math.max(0, room)) + '\n[实时输出已达上限，已停止实时显示]\n'
        capped = true
        flush()
        return
      }
      buf += text
      if (buf.length >= 4096) flush()
      else timer ??= setTimeout(flush, 40)
    },
    end: flush,
  }
}

interface PwshRun {
  text: string
  stdout: string
  stderr: string
  exitCode: number | null // null = 超时/启动失败/被终止
  durationMs: number
  timedOut: boolean
}
// PowerShell 启动前置（Codex / Claude Code 同思路）：输出锁到 UTF-8（无 BOM）；
// 脚本通过 stdin 以原始字节传入（显式 UTF-8 解码），避开 Windows 命令行 ~32K 上限和引号转义问题。
// 不用 [Console]::InputEncoding：它会改动共享控制台的输入代码页，影响父进程。
const PWSH_BOOTSTRAP = [
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}',
  'try {',
  '  $ms = [System.IO.MemoryStream]::new()',
  '  [Console]::OpenStandardInput().CopyTo($ms)',
  '  Invoke-Expression ([System.Text.Encoding]::UTF8.GetString($ms.ToArray()))',
  '} catch { Write-Error $_; exit 1 }',
].join('\n')

// pwsh 可执行文件：优先固定安装位置（与 Claude Code 一致），找不到再交给 PATH。
// PowerShell 7 安装后不一定在当前 PATH 里（尤其是从 IDE/服务启动的进程）。
let pwshBin: string | null = null
function resolvePwsh(): string {
  if (pwshBin) return pwshBin
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const fixed = [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
  ]
  pwshBin = fixed.find((p) => fs.existsSync(p)) ?? 'pwsh.exe'
  return pwshBin
}

function runPwsh(command: string, timeoutSeconds: number, signal: AbortSignal, cwd: string, onOutput?: (text: string) => void) {
  const { promise, resolve, reject } = Promise.withResolvers<PwshRun>()
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PWSH_BOOTSTRAP]
  const startedAt = Date.now()
  const child = spawn(resolvePwsh(), args, {
    shell: false,
    windowsHide: true,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', TEMP: path.join(WORKSPACE_DIR, 'tmp'), TMP: path.join(WORKSPACE_DIR, 'tmp'), TMPDIR: path.join(WORKSPACE_DIR, 'tmp') },
  })
  // 子进程提前退出时写 stdin 会 EPIPE：吞掉，结果由 exit/close 收尾
  child.stdin.on('error', () => {})
  try {
    child.stdin.end(command, 'utf8')
  } catch {
    // 已退出
  }
  const stdoutSink = { chunks: [] as Buffer[], bytes: 0, dropped: 0 }
  const stderrSink = { chunks: [] as Buffer[], bytes: 0, dropped: 0 }
  const keepLatest = (sink: { chunks: Buffer[]; bytes: number; dropped: number }, chunk: Buffer) => {
    sink.chunks.push(chunk)
    sink.bytes += chunk.length
    while (sink.bytes > PWSH_MAX_CAPTURE_BYTES) {
      const head = sink.chunks[0]
      const excess = sink.bytes - PWSH_MAX_CAPTURE_BYTES
      if (head.length <= excess) {
        sink.chunks.shift()
        sink.bytes -= head.length
        sink.dropped += head.length
      } else {
        sink.chunks[0] = head.subarray(excess)
        sink.bytes -= excess
        sink.dropped += excess
      }
    }
  }
  child.stdout.on('data', (chunk: Buffer) => keepLatest(stdoutSink, chunk))
  child.stderr.on('data', (chunk: Buffer) => keepLatest(stderrSink, chunk))
  // 实时回显（仅前端展示；交给模型的仍是结束时的规范化文本）
  const live = onOutput ? makeLiveEmitter(onOutput) : null
  const stdoutLive = live ? liveTextStream((t) => live.push(t)) : null
  const stderrLive = live ? liveTextStream((t) => live.push(t)) : null
  const endLive = () => {
    stdoutLive?.end()
    stderrLive?.end()
    live?.end()
  }
  if (stdoutLive) child.stdout.on('data', (chunk: Buffer) => stdoutLive.write(chunk))
  if (stderrLive) child.stderr.on('data', (chunk: Buffer) => stderrLive.write(chunk))
  let timedOut = false
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let exitTimer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  const cleanup = () => {
    clearTimeout(timer)
    clearTimeout(exitTimer)
    clearTimeout(killTimer)
    signal.removeEventListener('abort', onAbort)
    endLive()
    // 释放我方读端：后台子进程继承了写端时，句柄不关会一直挂着
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  const finish = (code: number | null, spawnError?: Error) => {
    if (settled) return
    settled = true
    cleanup()
    const durationMs = Date.now() - startedAt
    const stdout = stripAnsi(decodeOutput(Buffer.concat(stdoutSink.chunks))).trim()
    const stderr = stripAnsi(decodeOutput(Buffer.concat(stderrSink.chunks))).trim()
    // 状态标记统一放正文前：退出码/超时/启动失败才决定 isError；
    // stderr 只标段不判失败（命令成功但程序往 stderr 打印很常见）
    const head: string[] = []
    if (spawnError) {
      const code = (spawnError as NodeJS.ErrnoException).code
      head.push(`[启动失败] ${code === 'ENOENT' ? '找不到 pwsh.exe' : code === 'EACCES' || code === 'EPERM' ? '没有权限执行 pwsh.exe' : spawnError.message}`)
    }
    else if (timedOut) head.push(`[超时] 运行 ${(durationMs / 1000).toFixed(1)}s（上限 ${timeoutSeconds}s）`)
    else if (code == null) head.push('[进程被终止]')
    else if (code !== 0) head.push(`[退出码 ${code}]`)
    const rolled = stdoutSink.dropped + stderrSink.dropped
    if (rolled > 0) head.push(`[截断] 捕获上限 ${PWSH_MAX_CAPTURE_BYTES / 1024 / 1024}MB，丢弃前 ${rolled} 字节`)
    // stdout/stderr 是两条独立管道，交错顺序无法还原；两段都有时加标签分段
    const body = stdout && stderr
      ? `[stdout]\n${stdout}\n[stderr]\n${stderr}`
      : stderr
        ? `[stderr]\n${stderr}`
        : stdout || (spawnError ? '' : '(无输出)')
    if (body) head.push(clipMiddle(body, PWSH_MAX_OUTPUT_CHARS))
    resolve({ text: head.join('\n'), stdout, stderr, exitCode: timedOut || spawnError ? null : code, durationMs, timedOut })
  }
  // 用户停止：直接 reject（调用方按"已停止"处理），不产出结果文本
  const abort = () => {
    if (settled) return
    settled = true
    cleanup()
    reject(new Error('aborted'))
  }
  const settle = (code: number | null) => (signal.aborted ? abort() : finish(code))
  // 超时/停止：先 kill 主进程；若 kill 后连 exit 都收不到（进程状态异常），3 秒后强制收尾，
  // 保证任何情况下都不会无限挂起
  const killChild = () => {
    child.kill()
    killTimer ??= setTimeout(() => settle(null), PWSH_KILL_GRACE_MS)
  }
  const onAbort = () => killChild()
  signal.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(() => {
    timedOut = true
    killChild()
  }, timeoutSeconds * 1000)
  child.on('error', (err) => finish(null, err))
  // pwsh 退出 ≠ 管道关闭：Start-Process/后台任务会继承 stdout/stderr 的写端，'close' 可能永远不来
  // （实测：后台 node 继承管道后，pwsh 退出但 close 永不触发，工具一直挂到超时也收不了尾）。
  // 'exit' 只关心主进程本身，留一小段宽限期收完管道里剩余数据后自行收尾。
  child.on('exit', (code) => {
    exitTimer = setTimeout(() => settle(code), PWSH_EXIT_GRACE_MS)
  })
  child.on('close', (code) => settle(code))
  return promise
}

// MCP 的底层错误统一收敛成可读文案；未知错误保留原始 message
const mcpErrorText = (err: unknown): string => {
  const msg = errMsg(err)
  if (/-32001|request timed out/i.test(msg)) return `执行超时（${MCP_TOOL_TIMEOUT / 1000}s）`
  if (/connection closed|transport closed|not connected/i.test(msg)) return '连接已断开'
  return msg
}

export async function executeTool(tc: ToolCall, signal: AbortSignal, onOutput?: (text: string) => void): Promise<ToolResult> {
  // 统一解析：参数必须是 JSON 对象；各工具再做严格校验（未知参数/类型/范围/必填）
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = tc.arguments ? JSON.parse(tc.arguments) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象')
    raw = parsed as Record<string, unknown>
  } catch (err) {
    return { text: `工具参数错误: ${err instanceof SyntaxError ? '参数不是合法 JSON' : errMsg(err)}`, isError: true }
  }
  if (tc.name === 'search') {
    try {
      return await searchTool(validateArgs('search', raw, SEARCH_ARGS))
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `搜索失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'read') {
    try {
      return readTool(validateArgs('read', raw, READ_ARGS))
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `读取失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'edit') {
    try {
      return editTool(validateArgs('edit', raw, EDIT_ARGS))
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `编辑失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'write') {
    try {
      return writeTool(validateArgs('write', raw, WRITE_ARGS))
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `写入失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'read_image') {
    let abs = ''
    try {
      const args = validateArgs('read_image', raw, READ_IMAGE_ARGS)
      const p = String(args.path)
      const cwd = resolveCwd(args.cwd)
      if ('error' in cwd) return { text: `读取图片失败: ${cwd.error}`, isError: true }
      abs = path.resolve(cwd.dir, p)
      const st = fs.statSync(abs)
      if (!st.isFile()) throw new Error(`不是文件: ${abs}`)
      if (st.size > 20 * 1024 * 1024) throw new Error(`图片过大（上限 20MB）: ${abs}`)
      const ext = path.extname(abs).toLowerCase()
      const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
      const mime = MIME_BY_EXT[ext]
      if (!mime) throw new Error(`不支持的图片格式（仅支持 png/jpg/webp/gif）: ${ext || '(无扩展名)'}`)
      const dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
      return { text: `已读取图片 ${abs}（${st.size} 字节）`, images: [dataUrl] }
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `读取图片失败: ${fsErrorText(err, abs || String(raw.path ?? ''))}`, isError: true }
    }
  }
  if (tc.name === 'pwsh') {
    try {
      const args = validateArgs('pwsh', raw, PWSH_ARGS)
      // 开关关闭时工具不下发给模型；即使模型凭历史记忆硬调，也不应该执行
      if (!readSettings().pwsh) return { text: '工具执行失败: pwsh 工具未启用', isError: true }
      const cwd = resolveCwd(args.cwd)
      if ('error' in cwd) return { text: `工具执行失败: ${cwd.error}`, isError: true }
      const timeoutSeconds = typeof args.timeout === 'number' ? Math.min(args.timeout, PWSH_MAX_TIMEOUT_S) : PWSH_DEFAULT_TIMEOUT_S
      const r = await runPwsh(String(args.command), timeoutSeconds, signal, cwd.dir, onOutput)
      return {
        text: r.text,
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        isError: r.exitCode !== 0, // 超时/启动失败/被终止时 exitCode 为 null
      }
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `工具执行失败: ${errMsg(err)}`, isError: true }
    }
  }
  // MCP 工具：路由到对应服务器的连接（超时 + 用户停止信号）。
  // 参数契约由服务器 inputSchema 定义：只校验 schema 语义下无歧义的必填/未知参数。
  const m = mcpToolMap.get(tc.name)
  if (m?.entry.client) {
    try {
      validateMcpArgs(tc.name, m.tool.inputSchema, raw)
      const result = (await m.entry.client.callTool(
        { name: m.tool.name, arguments: raw },
        undefined,
        { timeout: MCP_TOOL_TIMEOUT, signal },
      )) as CallToolResult
      return formatMcpResult(result)
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `MCP 工具执行失败: ${mcpErrorText(err)}`, isError: true }
    }
  }
  return { text: `未知工具: ${tc.name}`, isError: true }
}