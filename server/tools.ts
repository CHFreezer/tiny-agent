import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import OpenAI from 'openai'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { WORKSPACE_DIR, errMsg, readSettings, resolveCwd } from './config.ts'
import { MCP_TOOL_TIMEOUT, mcpToolMap, mcpTools } from './mcp.ts'
import { editTool, readTool, writeTool } from './files.ts'
import { searchTool } from './search.ts'
import { clipMiddle } from './text.ts'
import type { ToolCall, ToolResult } from './types.ts'

// 内置工具（OpenAI function calling 格式）
const READ_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read',
    description: `读取文件。encoding 默认 "utf-8"；encoding:"hex" 为十六进制模式（地址 + 16 字节/行 + ASCII）。
- 文本：line = 起始行（1-based，默认 1），limit = 行数（默认/上限 2000）；输出 cat -n 风格（行号右对齐 + Tab），行号不要复制进 old
- hex：offset = 字节偏移（0-based，支持 0x），limit = 字节数（默认 1024，上限 4096）
编码支持 iconv-lite 标签。路径相对 cwd（默认 workspace 根目录，也支持绝对路径）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        encoding: { type: 'string', description: '文本编码（默认 utf-8）或 "hex"' },
        line: { type: 'number', description: '文本：起始行（1-based，默认 1）' },
        offset: { type: ['number', 'string'], description: 'hex：字节偏移（0-based，支持 0x）' },
        limit: { type: 'number', description: '文本=行数；hex=字节数' },
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
    description: `修改现有文件（创建用 write）。
文本：old 空/省略=插入（无 line 仅空文件；有 line 插到该行行首，new 需自带换行；行数+1=末尾，仅当文件以换行结尾）；否则替换 old，new 空=删除；多处默认第一处，replace_all 全部；换行按输入原样匹配。
hex：offset 必填，old/new 为十六进制字节；old 空=插入，new 空=删除；replace_all、line 不可用。
校验：文本按编码精确查找 old；hex 在 offset 处做 sha256 校验。路径相对 cwd（默认 workspace 根目录）。`,
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
    description: `创建新文件（已存在则失败；修改用 edit），自动建父目录。
- content：内容；encoding 默认 "utf-8"，encoding:"hex" 时为十六进制字节
- 不写 BOM（需要 BOM 用 hex 显式写入）
路径相对 cwd（默认 workspace 根目录，也支持绝对路径）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '内容；hex 模式为十六进制字节' },
        encoding: { type: 'string', description: '文本编码（默认 utf-8）或 "hex"' },
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
    description: `在目录或单个文件中搜索文本（ripgrep --json）。path 相对 cwd（默认 workspace，也支持绝对路径），可以是目录或文件；文件名命中也会作为结果返回。
mode：literal（默认，按字面量匹配，元字符不生效）或 regex（ripgrep 正则，支持 PCRE2 lookaround）。
flags：可选组合字符串：
- i = 忽略大小写
- w = 全词匹配
示例：{ pattern: "foo.bar", flags: "iw" } 字面量 + 忽略大小写 + 全词；{ pattern: "foo\\\\d+", mode: "regex", flags: "i" }。
默认搜索隐藏文件，但排除 .git/.hg/.svn/CVS/.DS_Store/node_modules/bower_components/*.code-search（与 VS Code 默认对齐）。
- max_results：最多结果数（默认 100，上限 1000），达到后立即停止
- timeout：超时秒数（默认 30，最大 600）
- context：命中前后各显示 N 行上下文（默认 0，上限 20；上下文不计入结果数）
- encoding：文件编码（如 gbk / shift_jis / utf-16le）；默认自动/UTF-8。非 UTF-8 文件建议显式指定
- include：只搜索匹配这些 glob 的文件（如 ["**/*.ts"]；任意层级用 **/ 前缀）
- exclude：追加排除的 glob 列表，如 ["**/node_modules/**", "**/*.min.js"]（不以 ** 或 / 开头的模式锚定搜索根；任意层级用 **/ 前缀）；默认遵循 .gitignore（即使不在 git 仓库内）`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索文本；默认按字面量，mode:"regex" 时按 ripgrep 正则解释' },
        mode: { type: 'string', enum: ['literal', 'regex'], description: '匹配模式：literal（默认）或 regex' },
        flags: { type: 'string', description: '可选组合：i=忽略大小写，w=全词匹配' },
        path: { type: 'string', description: '搜索路径：目录或文件（相对 cwd，默认 .）' },
        cwd: { type: 'string', description: '工作目录覆盖（必须已存在；相对路径基于 workspace，省略=workspace）' },
        max_results: { type: 'number', description: '最多结果数（默认 100，上限 1000）' },
        timeout: { type: 'number', description: '超时秒数（默认 30，最大 600）' },
        context: { type: 'number', description: '命中前后各显示 N 行上下文（默认 0，上限 20）' },
        encoding: { type: 'string', description: '文件编码（如 gbk / shift_jis / utf-16le）；默认自动/UTF-8' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: '只搜索匹配这些 glob 的文件（任意层级用 **/ 前缀），如 ["**/*.ts"]',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: '追加排除的 glob（不以 ** 或 / 开头的模式锚定搜索根；任意层级用 **/ 前缀），如 ["**/node_modules/**", "**/*.min.js"]；默认遵循 .gitignore',
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
    description: `在本地机器上执行 PowerShell 7（pwsh.exe）命令并返回输出，可用于系统查询、文件操作等。cwd 可覆盖工作目录（必须是已存在目录；默认 workspace 根目录）。`,
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
    description: `读取本机图片文件（png/jpg/webp/gif）并让模型看到图片内容（例如其他工具或脚本截图落盘后的文件）。路径相对 cwd（默认 workspace 根目录，也支持绝对路径）。`,
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

// 当前工具集（与生成请求同源）：生成循环与压缩请求共用
export function currentTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [...(readSettings().pwsh ? [PWSH_TOOL] : []), SEARCH_TOOL, READ_TOOL, EDIT_TOOL, WRITE_TOOL, READ_IMAGE_TOOL, ...mcpTools()]
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
const MCP_MAX_OUTPUT_CHARS = 8000 // MCP 文本结果上限（与 pwsh 同策略）

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
// 实时回显流：逐块解码（UTF-8 多字节、ANSI 转义序列都可能被块边界截断，留到下一块）
function liveTextStream(onText: (text: string) => void) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const push = (s: string) => {
    const text = stripAnsi(s)
    if (text) onText(text)
  }
  return {
    write(chunk: Buffer) {
      let s = pending + decoder.write(chunk)
      pending = ''
      const cut = /\x1b(?:\[[0-9;]*)?$/.exec(s)
      if (cut) {
        pending = cut[0]
        s = s.slice(0, cut.index)
      }
      push(s)
    },
    end() {
      const s = pending + decoder.end()
      pending = ''
      push(s)
    },
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
function runPwsh(command: string, timeoutSeconds: number, signal: AbortSignal, cwd: string, onOutput?: (text: string) => void) {
  const { promise, resolve, reject } = Promise.withResolvers<PwshRun>()
  const preparedCommand =
    `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n` +
    command
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', preparedCommand]
  const startedAt = Date.now()
  const child = spawn('pwsh.exe', args, {
    shell: false,
    windowsHide: true,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', TEMP: path.join(WORKSPACE_DIR, 'tmp'), TMP: path.join(WORKSPACE_DIR, 'tmp'), TMPDIR: path.join(WORKSPACE_DIR, 'tmp') },
  })
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
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutSeconds * 1000)
  const onAbort = () => child.kill()
  signal.addEventListener('abort', onAbort, { once: true })
  let settled = false
  const finish = (code: number | null, spawnError?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    const durationMs = Date.now() - startedAt
    const stdout = stripAnsi(Buffer.concat(stdoutSink.chunks).toString('utf8')).trim()
    const stderr = stripAnsi(Buffer.concat(stderrSink.chunks).toString('utf8')).trim()
    // 状态标记统一放正文前：退出码/超时/启动失败才决定 isError；
    // stderr 只标段不判失败（命令成功但程序往 stderr 打印很常见）
    const head: string[] = []
    if (spawnError) head.push(`[启动失败] ${spawnError.message}`)
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
  child.on('error', (err) => {
    endLive()
    finish(null, err)
  })
  child.on('close', (code) => {
    endLive()
    if (signal.aborted) reject(new Error('aborted'))
    else finish(code)
  })
  return promise
}

export async function executeTool(tc: ToolCall, signal: AbortSignal, onOutput?: (text: string) => void): Promise<ToolResult> {
  if (tc.name === 'search') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      return await searchTool(args)
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `搜索失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'read') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      return readTool(args)
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `读取失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'edit') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      return editTool(args)
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `编辑失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'write') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      return writeTool(args)
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `写入失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'read_image') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      const p = String(args.path ?? '')
      const cwd = resolveCwd(args.cwd)
      if ('error' in cwd) return { text: `读取图片失败: ${cwd.error}`, isError: true }
      const abs = path.resolve(cwd.dir, p)
      const st = fs.statSync(abs)
      if (!st.isFile()) throw new Error('不是文件')
      if (st.size > 20 * 1024 * 1024) throw new Error('图片过大（上限 20MB）')
      const ext = path.extname(abs).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png'
      const dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
      return { text: `已读取图片 ${abs}（${st.size} 字节）`, images: [dataUrl] }
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `读取图片失败: ${errMsg(err)}`, isError: true }
    }
  }
  if (tc.name === 'pwsh') {
    try {
      const args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
      const cwd = resolveCwd(args.cwd)
      if ('error' in cwd) return { text: `工具执行失败: ${cwd.error}`, isError: true }
      const requested = Math.floor(Number(args.timeout))
      const timeoutSeconds = Number.isFinite(requested) && requested > 0 ? Math.min(requested, PWSH_MAX_TIMEOUT_S) : PWSH_DEFAULT_TIMEOUT_S
      const r = await runPwsh(String(args.command ?? ''), timeoutSeconds, signal, cwd.dir, onOutput)
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
      return formatMcpResult(result)
    } catch (err) {
      if (signal.aborted) throw err
      return { text: `MCP 工具执行失败: ${errMsg(err)}`, isError: true }
    }
  }
  return { text: `未知工具: ${tc.name}`, isError: true }
}