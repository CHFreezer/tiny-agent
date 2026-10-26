import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveCwd } from './config.ts'
import { clipMiddle, cutText, tailText } from './text.ts'
import { fsErrorText } from './fsError.ts'
import type { SearchFile, SearchLine, SearchResult, ToolResult } from './types.ts'

// ===== search：ripgrep 原生语义 =====
// mode=content：搜索文件内容，返回文件/行号/命中行；mode=files：pattern 是 glob，只返回文件路径。
// include/exclude 直接使用 rg glob：* 不跨目录，** 跨目录；不带 / 的模式按 basename 任意层级匹配。
// 达到 max_results 或超时立即 kill rg。
const DEFAULT_MAX_RESULTS = 100
const MAX_RESULTS_LIMIT = 1000
const DEFAULT_TIMEOUT_S = 30
const MAX_TIMEOUT_S = 600
const MAX_LINE_CHARS = 400 // 单行显示上限（围绕首个命中裁剪）
const MAX_TEXT_CHARS = 10000 // 交给模型的总字符上限

// 常见默认排除项（目录/文件名）；rg 会据此跳过整个目录
const DEFAULT_EXCLUDES = [
  '**/node_modules',
  '**/bower_components',
  '**/*.code-search',
  '**/.git',
  '**/.svn',
  '**/.hg',
  '**/.jj',
  '**/.DS_Store',
  '**/Thumbs.db',
]
const MAX_FILE_SIZE = 16 * 1024 * 1024 * 1024 // VS Code 文本搜索的平台上限
// VS Code 在非 Linux 平台按大小写不敏感匹配 glob 与 ignore 文件（searchView: ignoreGlobCase = !isLinux）
const CASE_INSENSITIVE_GLOB_ARGS = process.platform === 'linux' ? [] : ['--glob-case-insensitive', '--ignore-file-case-insensitive']
// 单文件精确匹配用的 glob 转义（文件名里的元字符按字面量处理）
const GLOB_META = '*?[]{}!'
const BACKSLASH = String.fromCharCode(92)
const escapeGlobName = (name: string) =>
  [...name].map((c) => (GLOB_META.includes(c) || c === BACKSLASH ? BACKSLASH + c : c)).join('')

// ===== pattern 处理 =====
// 与 VS Code unicodeEscapesToPCRE2 一致：\uXXXX / \u{XXXX} → \x{XXXX}（奇数个反斜杠才算转义）
const unicodeEscapesToPCRE2 = (pattern: string): string => {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] !== BACKSLASH) {
      out += pattern[i++]
      continue
    }
    let count = 0
    while (i < pattern.length && pattern[i] === BACKSLASH) {
      count++
      i++
    }
    if (count % 2 === 1 && pattern[i] === 'u') {
      const plain = pattern.slice(i + 1, i + 5)
      if (plain.length === 4 && /^[a-z0-9]{4}$/i.test(plain)) {
        out += BACKSLASH.repeat(count) + 'x{' + plain + '}'
        i += 5
        continue
      }
      if (pattern[i + 1] === '{' && /^[a-z0-9]{4}$/i.test(pattern.slice(i + 2, i + 6)) && pattern[i + 6] === '}') {
        out += BACKSLASH.repeat(count) + 'x{' + pattern.slice(i + 2, i + 6) + '}'
        i += 7
        continue
      }
    }
    out += BACKSLASH.repeat(count)
  }
  return out
}

interface BuiltPattern {
  args: string[]
  positional?: string
}

// 全词交给 rg --word-regexp：Unicode 词边界，literal/regex 都适用。
// 不复刻 VS Code 的 \b 拼接（那套对空白/标点/CJK/交替都不够直观）。
const buildPatternArgs = (pattern: string, syntax: 'literal' | 'regex', wholeWord: boolean): BuiltPattern => {
  const isRegex = syntax === 'regex'
  const wordArgs = wholeWord ? ['--word-regexp'] : []
  if (isRegex) return { args: ['--engine', 'auto', ...wordArgs, '--regexp', unicodeEscapesToPCRE2(pattern)] }
  return { args: ['--fixed-strings', ...wordArgs], positional: pattern }
}

// ===== 与 VS Code searchCompare 默认排序一致 =====
const fileNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const compareFileNames = (a: string, b: string): number => {
  const r = fileNameCollator.compare(a, b)
  if (r === 0 && a !== b && fileNameCollator.resolvedOptions().numeric) return a < b ? -1 : 1
  return r
}
const comparePaths = (a: string, b: string): number => {
  const ap = a.split('/')
  const bp = b.split('/')
  const lastA = ap.length - 1
  const lastB = bp.length - 1
  for (let i = 0; ; i++) {
    const endA = lastA === i
    const endB = lastB === i
    if (endA && endB) return compareFileNames(ap[i], bp[i])
    if (endA) return -1
    if (endB) return 1
    const ac = ap[i].toLowerCase()
    const bc = bp[i].toLowerCase()
    if (ac !== bc) return ac < bc ? -1 : 1
  }
}

// include/exclude 共用的 glob 归一化（照搬 VS Code）：字符串或数组、去前导 !、正斜杠、去重、限长限量
const normalizeGlobs = (v: unknown): string[] => [
  ...new Set(
    (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => cutText(x.trim().replace(/^!+/, '').replace(/\\/g, '/'), 260))
      .filter(Boolean)
      .slice(0, 50),
  ),
]

// rg 二进制：优先用 @vscode/ripgrep 自带的，缺失时回退 PATH 上的 rg。
// 动态 import 避免可选平台包缺失时把整个 server 启动打挂。
let rgBin: string | null = null
async function resolveRg(): Promise<string> {
  if (rgBin) return rgBin
  try {
    const mod = (await import('@vscode/ripgrep')) as { rgPath?: string }
    if (mod.rgPath && fs.existsSync(mod.rgPath)) {
      rgBin = mod.rgPath
      return rgBin
    }
  } catch {
    // 可选依赖缺失：回退 PATH
  }
  rgBin = 'rg'
  return rgBin
}

const fail = (text: string): ToolResult => ({ text, isError: true })

// 子进程启动失败：把 Node 的 spawn 错误收敛成可读文案
const spawnErrorText = (err: Error): string => {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return '找不到 rg 可执行文件'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限执行 rg'
  return err.message
}
// rg 的 stderr 是引擎自己的诊断：纯权限类报错只给结论，避免把 os error 噪音透给模型。
// stderr 只保留末尾 4000 字符，可能从行中间开始，因此只统计完整的 "rg:" 诊断行。
const summarizeRgError = (raw: string): string => {
  const diagnostics = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^rg:/i.test(l))
  // 逐文件的 OS 级读取错误（权限/占用/系统拒绝等）对模型没有可操作信息，统一收敛
  const accessNoise = /os error \d+\b|拒绝访问|另一个程序已锁定|系统无法访问此文件|being used by another process|Permission denied|Access is denied/i
  if (diagnostics.length && diagnostics.every((l) => accessNoise.test(l))) {
    return '部分路径无法读取'
  }
  // 正则编译失败：rg 会输出两套引擎的长篇诊断，只保留第一处可读原因
  if (/regex (could not be compiled|parse error)/i.test(raw)) {
    const detail = /^error: (.+)$/m.exec(raw)?.[1] ?? /PCRE2: error compiling pattern[^:]*:\s*(.+)$/m.exec(raw)?.[1] ?? ''
    return `正则表达式无法编译${detail ? `：${detail.trim()}` : ''}`
  }
  const globErr = /error parsing glob '([^']*)':\s*(.+)/.exec(raw)
  if (globErr) return `glob 无效（${globErr[1]}）：${globErr[2].trim()}`
  const encErr = /unknown encoding:\s*(\S+)/i.exec(raw)
  if (encErr) return `不支持的编码：${encErr[1]}`
  return raw
}

// 按行切分流式输出（块边界可能切在行中间，也可能切在多字节字符中间）
function lineSplitter(onLine: (line: string) => void) {
  let buf = ''
  const decoder = new TextDecoder('utf-8')
  return {
    push(chunk: Buffer) {
      buf += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.trim()) onLine(line)
      }
    },
    end() {
      buf += decoder.decode()
      if (buf.trim()) onLine(buf.trim())
      buf = ''
    },
  }
}

// rg 的 submatches 用的是 UTF-8 字节偏移；这里映射到 JS 字符串索引。
// 注意要同时累计 UTF-16 长度：emoji/生僻字是一个码点但占两个 UTF-16 单元。
const offsetMap = (s: string) => {
  const bytes = [0]
  const chars = [0]
  let b = 0
  let c = 0
  for (const ch of s) {
    b += Buffer.byteLength(ch)
    c += ch.length
    bytes.push(b)
    chars.push(c)
  }
  return { bytes, chars }
}
const charIndex = (map: { bytes: number[]; chars: number[] }, byte: number) => {
  let lo = 0
  let hi = map.bytes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (map.bytes[mid] < byte) lo = mid + 1
    else hi = mid
  }
  return map.chars[lo]
}

// 超长行围绕首个命中裁剪，保留前后文，并把命中区间平移
// 边界不能落在 UTF-16 代理对中间，否则会生成 lone surrogate（上游 JSON 解析会 400）
const clampLine = (text: string, ranges: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } => {
  if (text.length <= MAX_LINE_CHARS) return { text, ranges }
  const first = ranges[0]?.[0] ?? 0
  let start = Math.max(0, Math.min(first - 100, text.length - MAX_LINE_CHARS))
  if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--
  let end = start + MAX_LINE_CHARS
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end++
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const shifted = ranges
    .filter(([a, b]) => b > start && a < end)
    .map(([a, b]) => [Math.max(a, start) - start + prefix.length, Math.min(b, end) - start + prefix.length] as [number, number])
  return { text: prefix + text.slice(start, end) + suffix, ranges: shifted }
}

const firstCodePointLength = (text: string) =>
  text.length >= 2 && text.charCodeAt(0) >= 0xd800 && text.charCodeAt(0) <= 0xdbff ? 2 : Math.min(1, text.length)

// 相对 cwd 的显示路径（目录外则用绝对路径），统一正斜杠
const displayPath = (cwd: string, p: string) => {
  const abs = path.resolve(cwd, p)
  const rel = path.relative(cwd, abs)
  const out = rel === '' ? '.' : rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs
  return out.split(path.sep).join('/')
}

// rg 的 path/lines 可能是 {text} 或 {bytes: base64}（非 UTF-8）；两种都要能取
const bytesOrText = (v: unknown): string => {
  if (!v || typeof v !== 'object') return ''
  const o = v as { text?: unknown; bytes?: unknown }
  if (typeof o.text === 'string') return o.text
  if (typeof o.bytes === 'string') return Buffer.from(o.bytes, 'base64').toString('utf8')
  return ''
}

interface ContentScan {
  files: Map<string, SearchFile>
  total: number
  truncated: boolean
  timedOut: boolean
  nonUtf8: boolean
  error?: string
}

// 行号排序 + 去重；只有上下文的文件（例如重搜时命中被跳过）不保留
const normalizeMatches = (files: Map<string, SearchFile>) => {
  for (const [p, file] of files) {
    file.matches.sort((a, b) => a.line - b.line || (a.kind === 'context' ? 1 : 0) - (b.kind === 'context' ? 1 : 0))
    const dedup: SearchLine[] = []
    for (const m of file.matches) {
      const prev = dedup[dedup.length - 1]
      if (prev && prev.line === m.line) {
        if (prev.kind === 'context' && m.kind !== 'context') dedup[dedup.length - 1] = m
        continue
      }
      dedup.push(m)
    }
    file.matches = dedup
    if (!file.matches.some((m) => m.kind === 'match')) files.delete(p)
  }
}

// rg --json 流式内容搜索；达到 remaining 或超时 kill。
// 与 VS Code 一致：rg 的 cwd 始终设为目录搜索根（路径传 "."），二进制文件由 rg 的目录扫描规则跳过。
// 单文件模式把根设为文件所在目录，并用锚定到根的字面量 glob 限定到该文件。
function scanContent(pattern: string, abs: string, toolCwd: string, remaining: number, timeoutMs: number, rg: string, includes: string[], excludes: string[], opts: { syntax: 'literal' | 'regex'; ignoreCase: boolean; wholeWord: boolean; context: number; encoding?: string; exactFile?: string; exactDisplay?: string }): Promise<ContentScan> {
  // whole word 交给 rg --word-regexp（Unicode 词边界）；regex 里的 \uXXXX 先转成 PCRE2 的 \x{...}
  const patternArgs = buildPatternArgs(pattern, opts.syntax, opts.wholeWord)
  return new Promise((resolve) => {
    const files = new Map<string, SearchFile>()
    let total = 0
    let settled = false
    let truncated = false
    let timedOut = false
    let stopped = false
    let nonUtf8 = false
    let stderr = ''
    const stderrDecoder = new TextDecoder('utf-8')
    let exited: number | null = null
    const displayOf = (p: string) => displayPath(toolCwd, path.resolve(abs, p))
    // 显式指定单个文件时不套用用户 include/exclude；模式/大小写/编码仍然生效
    const common = [
      '--json',
      '--crlf',
      '--no-config',
      opts.ignoreCase ? '--ignore-case' : '--case-sensitive',
      ...(opts.context > 0 ? ['--before-context', String(opts.context), '--after-context', String(opts.context)] : []),
      ...(opts.encoding ? ['--encoding', opts.encoding] : []),
      ...patternArgs.args,
    ]
    const globArgs = [
      ...includes.flatMap((g) => ['--glob', g]),
      ...excludes.flatMap((g) => ['--glob', `!${g}`]),
    ]
    const tail = ['--', ...(patternArgs.positional !== undefined ? [patternArgs.positional] : []), '.']
    const args = opts.exactFile
      ? [
          ...common,
          '--hidden',
          '--no-ignore',
          '--no-require-git',
          '--follow',
          '--max-depth',
          '1',
          // 大小写不敏感的文件系统上，用户输入的大小写可能与磁盘不一致；Linux 保持精确匹配
          ...CASE_INSENSITIVE_GLOB_ARGS,
          '--glob',
          opts.exactFile,
          '--max-filesize',
          String(MAX_FILE_SIZE),
          ...tail,
        ]
      : [
          ...common,
          '--hidden',
          '--no-require-git',
          '--max-filesize',
          String(MAX_FILE_SIZE),
          ...CASE_INSENSITIVE_GLOB_ARGS,
          ...globArgs,
          ...tail,
        ]
    const child = spawn(rg, args, {
      cwd: abs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      normalizeMatches(files)
      const err = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
      const failed = exited === 2 || (err && total === 0)
      resolve({
        files,
        total,
        truncated,
        timedOut,
        nonUtf8,
        ...(failed ? { error: err || 'rg 执行失败' } : {}),
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const split = lineSplitter((line) => {
      if (stopped) return
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      const type = (msg as { type?: string }).type
      const data = (msg as { type?: string; data?: Record<string, unknown> }).data
      if ((type !== 'match' && type !== 'context') || !data) return
      const p = bytesOrText(data.path)
      const lineObj = data.lines as { text?: unknown; bytes?: unknown } | undefined
      const fromBytes = !!lineObj && typeof lineObj.bytes === 'string' && typeof lineObj.text !== 'string'
      if (fromBytes) nonUtf8 = true
      const lineText = bytesOrText(lineObj)
      if (!p || !lineText) return
      const text = lineText.replace(/\r?\n$/, '')
      // 单文件模式下 rg 报的是磁盘上的实际大小写，统一用用户给出的路径，避免与同名命中分裂成两条
      const display = opts.exactDisplay ?? displayOf(p)
      const file = files.get(display) ?? { path: display, matches: [] as SearchLine[] }
      if (type === 'context') {
        const clamped = clampLine(text, [])
        file.matches.push({ line: Number(data.line_number) || 0, text: clamped.text, ranges: [], count: 0, kind: 'context' })
        files.set(display, file)
        return
      }
      const available = remaining - total
      if (available <= 0) {
        truncated = true
        stopped = true
        child.kill()
        return
      }
      const map = offsetMap(text)
      // rg 对某些正则不会给出 submatches：退化为整行首个字符，保证有高亮与计数
      const matchedSubs = Array.isArray(data.submatches) && data.submatches.length
        ? data.submatches
        : [{ start: 0, end: firstCodePointLength(text), match: { text: text.slice(0, firstCodePointLength(text)) } }]
      // 精确裁剪到最后一行，保证总数不超过 max_results
      const subs = matchedSubs.length > available ? matchedSubs.slice(0, available) : matchedSubs
      if (subs.length < matchedSubs.length) {
        truncated = true
        stopped = true
      }
      let searchFrom = 0
      const ranges = subs
        .map((sm) => {
          let start = charIndex(map, Number((sm as { start?: number }).start) || 0)
          let end = charIndex(map, Number((sm as { end?: number }).end) || 0)
          // 非 UTF-8 行没有可靠的字节→字符映射：按 match 文本在解码后的行里定位
          if (fromBytes) {
            const matchText = bytesOrText((sm as { match?: unknown }).match)
            if (matchText) {
              const found = text.indexOf(matchText, searchFrom)
              if (found >= 0) {
                start = found
                end = found + matchText.length
                searchFrom = end
              }
            }
          }
          return [start, end] as [number, number]
        })
        .filter(([a, b]) => b > a)
      if (!ranges.length) ranges.push([0, firstCodePointLength(text)])
      const clamped = clampLine(text, ranges)
      file.matches.push({ line: Number(data.line_number) || 0, text: clamped.text, ranges: clamped.ranges, count: Math.max(1, subs.length), kind: 'match' })
      files.set(display, file)
      // 与 VS Code 一致：结果数按 submatch 计（同一行多处算多次），处理完整行后再 kill
      total += Math.max(1, subs.length)
      if (total >= remaining) {
        stopped = true
        truncated = true
        child.kill()
      }
    })
    child.stdout.on('data', (chunk: Buffer) => split.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = tailText(stderr + stderrDecoder.decode(chunk, { stream: true }), 4000)
    })
    child.on('error', (err) => {
      stderr = spawnErrorText(err)
      finish()
    })
    child.on('close', (code) => {
      exited = code
      stderr = tailText(stderr + stderrDecoder.decode(), 4000)
      split.end()
      finish()
    })
  })
}

interface FileScan {
  paths: string[]
  truncated: boolean
  timedOut: boolean
  error?: string
}

// rg --files：pattern 是 glob；excludes 为需要加 ! 的 glob；不读取内容
function scanFiles(
  root: string,
  toolCwd: string,
  patternGlob: string,
  maxResults: number,
  timeoutMs: number,
  rg: string,
  excludes: string[],
): Promise<FileScan> {
  return new Promise((resolve) => {
    const paths: string[] = []
    let settled = false
    let truncated = false
    let timedOut = false
    let stopped = false
    let stderr = ''
    const stderrDecoder = new TextDecoder('utf-8')
    let exited: number | null = null
    const args = [
      '--files',
      '--hidden',
      '--no-config',
      '--no-require-git',
      ...CASE_INSENSITIVE_GLOB_ARGS,
      '--glob',
      patternGlob,
      ...excludes.flatMap((g) => ['--glob', `!${g}`]),
      '--',
      '.',
    ]
    const child = spawn(rg, args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const err = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
      const failed = exited === 2 || (err && paths.length === 0)
      paths.sort(comparePaths)
      resolve({ paths, truncated, timedOut, ...(failed ? { error: err || 'rg 执行失败' } : {}) })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const split = lineSplitter((line) => {
      if (stopped) return
      if (paths.length >= maxResults) {
        truncated = true
        stopped = true
        child.kill()
        return
      }
      paths.push(displayPath(toolCwd, path.resolve(root, line)))
    })
    child.stdout.on('data', (chunk: Buffer) => split.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = tailText(stderr + stderrDecoder.decode(chunk, { stream: true }), 4000)
    })
    child.on('error', (err) => {
      stderr = spawnErrorText(err)
      finish()
    })
    child.on('close', (code) => {
      exited = code
      stderr = tailText(stderr + stderrDecoder.decode(), 4000)
      split.end()
      finish()
    })
  })
}

export async function searchTool(args: {
  pattern?: unknown
  mode?: unknown
  syntax?: unknown
  flags?: unknown
  path?: unknown
  cwd?: unknown
  max_results?: unknown
  timeout?: unknown
  exclude?: unknown
  include?: unknown
  context?: unknown
  encoding?: unknown
}): Promise<ToolResult> {
  const startedAt = Date.now()
  const NL = String.fromCharCode(10)
  const pattern = String(args.pattern ?? '')
  if (!pattern) return fail('搜索失败: 缺少 pattern')
  const mode: 'content' | 'files' = args.mode === 'files' ? 'files' : 'content'
  if (mode === 'files') {
    if (args.syntax !== undefined) return fail('搜索失败: files 模式不支持 syntax（pattern 是 glob）')
    if (args.flags !== undefined) return fail('搜索失败: files 模式不支持 flags（pattern 是 glob）')
    if (args.context !== undefined) return fail('搜索失败: files 模式不支持 context（只返回文件路径）')
    if (args.encoding !== undefined) return fail('搜索失败: files 模式不支持 encoding（不读取文件内容）')
    if (args.include !== undefined) return fail('搜索失败: files 模式不支持 include（pattern 已经是文件 glob；可用 exclude）')
    if (pattern.trimStart().startsWith('!')) return fail('搜索失败: files 模式的 pattern 必须是正向 glob；排除请用 exclude')
  }
  const cwd = resolveCwd(args.cwd)
  if ('error' in cwd) return fail(`搜索失败: ${cwd.error}`)
  const target = String(args.path ?? '.').trim() || '.'
  const abs = path.resolve(cwd.dir, target)
  let isDir = false
  let isFile = false
  try {
    const st = fs.statSync(abs)
    isDir = st.isDirectory()
    isFile = st.isFile()
    if (!isDir && !isFile) return fail(`搜索失败: 不是文件或目录: ${abs}`)
  } catch (err) {
    return fail(`搜索失败: ${fsErrorText(err, abs)}`)
  }
  if (mode === 'files' && !isDir) return fail(`搜索失败: files 模式的 path 必须是目录: ${abs}`)
  const toInt = (v: unknown, def: number) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n > 0 ? n : def
  }
  const maxResults = Math.min(toInt(args.max_results, DEFAULT_MAX_RESULTS), MAX_RESULTS_LIMIT)
  const timeoutS = Math.min(toInt(args.timeout, DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
  const timeoutMs = timeoutS * 1000
  const userExcludes = normalizeGlobs(args.exclude)
  const excludeGlobs = [...new Set([...DEFAULT_EXCLUDES, ...userExcludes])]
  const root = displayPath(cwd.dir, abs)
  const rg = await resolveRg()

  if (mode === 'files') {
    const scan = await scanFiles(abs, cwd.dir, pattern, maxResults, timeoutMs, rg, excludeGlobs)
    if (scan.error) return { text: clipMiddle(`搜索失败: ${summarizeRgError(scan.error)}`, MAX_TEXT_CHARS), isError: true }
    const files: SearchFile[] = scan.paths.map((p) => ({ path: p, matches: [] }))
    const result: SearchResult = {
      mode: 'files',
      pattern,
      root,
      files,
      totalMatches: 0,
      nameHits: files.length,
      truncated: scan.truncated,
      limit: maxResults,
      ...(userExcludes.length ? { exclude: userExcludes } : {}),
      ...(scan.timedOut ? { timedOut: true } : {}),
    }
    const filters = userExcludes.length ? `（排除：${userExcludes.join('、')}）` : ''
    const lines: string[] = [`[搜索文件] ${pattern} 于 ${root}${filters}`]
    if (!files.length) lines.push('未找到匹配')
    else for (const f of files) lines.push(f.path)
    lines.push(`[${files.length} 个文件${scan.timedOut ? '，搜索超时' : ''}]`)
    if (scan.truncated) lines.push(`[已截断] 已显示 ${files.length} 个文件（上限 ${maxResults}）`)
    return { text: clipMiddle(lines.join(NL), MAX_TEXT_CHARS), search: result, durationMs: Date.now() - startedAt }
  }

  const syntax: 'literal' | 'regex' = args.syntax === 'regex' ? 'regex' : 'literal'
  const flagStr = typeof args.flags === 'string' ? args.flags.toLowerCase() : ''
  const badFlags = [...new Set([...flagStr].filter((c) => c !== 'i' && c !== 'w'))]
  if (badFlags.length) return fail(`搜索失败: 不支持的 flags: ${badFlags.join('')}（仅支持 i、w）`)
  const ignoreCase = flagStr.includes('i')
  const wholeWord = flagStr.includes('w')
  const ctxRaw = Math.floor(Number(args.context))
  const contextLines = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.min(ctxRaw, 20) : 0
  const encodingArg = typeof args.encoding === 'string' ? args.encoding.trim() : ''
  if (encodingArg && !/^[A-Za-z0-9._-]+$/.test(encodingArg)) return fail(`搜索失败: 不支持的 encoding: ${encodingArg}`)
  const encoding = encodingArg ? encodingArg.slice(0, 32) : undefined
  const userIncludes = normalizeGlobs(args.include)
  const contentRoot = isDir ? abs : path.dirname(abs)
  const exactFile = isDir ? undefined : `/${escapeGlobName(path.basename(abs))}`
  const exactDisplay = isDir ? undefined : displayPath(cwd.dir, abs)
  const content = await scanContent(pattern, contentRoot, cwd.dir, maxResults, timeoutMs, rg, userIncludes, excludeGlobs, {
    syntax,
    ignoreCase,
    wholeWord,
    context: contextLines,
    encoding,
    exactFile,
    exactDisplay,
  })
  if (content.error) return { text: clipMiddle(`搜索失败: ${summarizeRgError(content.error)}`, MAX_TEXT_CHARS), isError: true }
  const files = [...content.files.values()].sort((a, b) => comparePaths(a.path, b.path))
  const result: SearchResult = {
    mode: 'content',
    syntax,
    pattern,
    root,
    files,
    totalMatches: content.total,
    nameHits: 0,
    truncated: content.truncated,
    limit: maxResults,
    ...(content.nonUtf8 ? { nonUtf8: true } : {}),
    ...(contextLines ? { context: contextLines } : {}),
    ...(userIncludes.length ? { include: userIncludes } : {}),
    ...(userExcludes.length ? { exclude: userExcludes } : {}),
    ...(content.timedOut ? { timedOut: true } : {}),
  }
  const headFilters = [
    userIncludes.length ? `仅：${userIncludes.join('、')}` : '',
    userExcludes.length ? `排除：${userExcludes.join('、')}` : '',
  ].filter(Boolean)
  const header = `[搜索] ${pattern} 于 ${root}${headFilters.length ? `（${headFilters.join('；')}）` : ''}`
  const lines: string[] = [header]
  if (!files.length) lines.push('未找到匹配')
  else {
    for (const file of files) {
      const fileCount = file.matches.reduce((n, m) => n + (m.kind === 'context' ? 0 : (m.count ?? m.ranges.length)), 0)
      lines.push(`${file.path}${fileCount ? `  (${fileCount})` : ''}`)
      let prevLine = -1
      for (const m of file.matches) {
        if (prevLine >= 0 && m.line > prevLine + 1) lines.push('      ...')
        const sep = m.kind === 'context' ? '-' : ':'
        lines.push(`${String(m.line).padStart(5)}${sep} ${m.text}`)
        prevLine = m.line
      }
    }
  }
  const nonUtf8Hint = content.nonUtf8 ? '，含非 UTF-8 内容' : ''
  lines.push(`[${files.length} 个文件，${content.total} 个结果${content.timedOut ? '，搜索超时' : ''}${nonUtf8Hint}]`)
  if (content.truncated) lines.push(`[已截断] 已显示 ${content.total} 个结果（上限 ${maxResults}）`)
  return { text: clipMiddle(lines.join(NL), MAX_TEXT_CHARS), search: result, durationMs: Date.now() - startedAt }
}
