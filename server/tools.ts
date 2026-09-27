import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import OpenAI from 'openai'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { WORKSPACE_DIR, errMsg, readSettings } from './config.ts'
import { MCP_TOOL_TIMEOUT, mcpToolMap, mcpTools } from './mcp.ts'
import type { ToolCall, ToolResult } from './types.ts'

// 内置工具（OpenAI function calling 格式）
export const PWSH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'pwsh',
    description: `在本地机器上执行 PowerShell 命令并返回输出，可用于系统查询、文件操作等。工作目录：${WORKSPACE_DIR}（相对路径文件操作落在这里）`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        timeoutSeconds: { type: 'number', description: '超时秒数，默认 30，最大 600' },
      },
      required: ['command'],
    },
  },
}
export const READ_IMAGE_TOOL: OpenAI.Chat.ChatCompletionTool = {
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

// 当前工具集（与生成请求同源）：生成循环与压缩请求共用
export function currentTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [...(readSettings().pwsh ? [PWSH_TOOL] : []), READ_IMAGE_TOOL, ...mcpTools()]
}

// ===== 工具执行（服务器侧） =====
// 只支持 PowerShell 7（pwsh.exe）：脚本正文作为单个 argv 元素交给 -Command，不做任何注入（照 opencode shell.ts:293）
const PWSH_DEFAULT_TIMEOUT_S = 30
const PWSH_MAX_TIMEOUT_S = 600
const PWSH_MAX_CAPTURE_BYTES = 1024 * 1024 // 捕获窗口（滚动）：只留最新这么多字节，超出丢最旧的，不杀进程
const PWSH_MAX_OUTPUT_CHARS = 10000 // 交给模型的字符上限（同样取最新的）
function runPwsh(command: string, timeoutSeconds: number, signal: AbortSignal) {
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; output: string }>()
  const preparedCommand =
    `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n` +
    command
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', preparedCommand]
  const startedAt = Date.now()
  const child = spawn('pwsh.exe', args, {
    shell: false,
    windowsHide: true,
    cwd: WORKSPACE_DIR,
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
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutSeconds * 1000)
  const onAbort = () => child.kill()
  signal.addEventListener('abort', onAbort, { once: true })
  let settled = false
  const finish = (exitCode: number, spawnError?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    const parts: string[] = []
    const out = Buffer.concat(stdoutSink.chunks).toString('utf8').trim()
    const errOut = Buffer.concat(stderrSink.chunks).toString('utf8').trim()
    if (out) parts.push(out)
    if (errOut) parts.push(errOut)
    // 进程正常结束但无输出 → (无输出)，别把整条命令行回显给模型；只有启动失败（ENOENT 等）才用 message
    const text = parts.join('\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') || (spawnError ? String(spawnError.message) : '(无输出)')
    // 两个窗口都是去头留尾：头部的信息缺失在正文前说明，被杀说明在正文后，三者都不参与窗口裁剪
    const head: string[] = []
    const rolled = stdoutSink.dropped + stderrSink.dropped
    if (rolled > 0) head.push(`[截断] 前 ${rolled} 字节（捕获上限 ${PWSH_MAX_CAPTURE_BYTES / 1024 / 1024}MB）`)
    if (text.length > PWSH_MAX_OUTPUT_CHARS) {
      head.push(`[截断] 前 ${text.length - PWSH_MAX_OUTPUT_CHARS} 字符（显示上限 ${PWSH_MAX_OUTPUT_CHARS}）`)
    }
    const tail = timedOut ? [`[超时] 运行 ${((Date.now() - startedAt) / 1000).toFixed(1)}s（上限 ${timeoutSeconds}s）`] : []
    resolve({ exitCode: timedOut ? 0 : exitCode, output: [...head, text.slice(-PWSH_MAX_OUTPUT_CHARS), ...tail].join('\n') })
  }
  child.on('error', (err) => finish(0, err))
  child.on('close', (code) => {
    if (signal.aborted) reject(new Error('aborted'))
    else finish(code ?? 0)
  })
  return promise
}

export async function executeTool(tc: ToolCall, signal: AbortSignal): Promise<ToolResult> {
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
      const requested = Math.floor(Number(args.timeoutSeconds))
      const timeoutSeconds = Number.isFinite(requested) && requested > 0 ? Math.min(requested, PWSH_MAX_TIMEOUT_S) : PWSH_DEFAULT_TIMEOUT_S
      const r = await runPwsh(String(args.command ?? ''), timeoutSeconds, signal)
      return { text: r.exitCode === 0 ? r.output : `[退出码 ${r.exitCode}]\n${r.output}` }
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