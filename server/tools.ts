import fs from 'node:fs'
import path from 'node:path'
import { execFile, execSync } from 'node:child_process'
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