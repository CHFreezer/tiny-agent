import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveCwd } from './config.ts'
import { clipMiddle } from './text.ts'
import type { SearchFile, SearchLine, SearchResult, ToolResult } from './types.ts'

// ===== search：ripgrep --json 流式搜索 =====
// 目录/单文件均可；path 相对 cwd（默认 workspace），也支持绝对路径。
// 与 VS Code 的文本搜索不同：文件名命中也会计入结果（单独标记，不参与行号匹配）。
// 达到 max_results 或超时立即 kill rg；内容命中与文件名命中共享总预算。
const DEFAULT_MAX_RESULTS = 100
const MAX_RESULTS_LIMIT = 1000
const DEFAULT_TIMEOUT_S = 30
const MAX_TIMEOUT_S = 600
const MAX_LINE_CHARS = 400 // 单行显示上限（围绕首个命中裁剪）
const MAX_TEXT_CHARS = 10000 // 交给模型的总字符上限

// 与 VS Code 的默认行为对齐：搜索隐藏文件（--hidden），但排除这些目录/文件。
// 路径 glob 默认锚定搜索根；任意层级请用 **/ 前缀。
const DEFAULT_EXCLUDES = [
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/CVS/**',
  '**/.DS_Store',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/*.code-search',
]
// 照 VS Code ripgrepSearchUtils.ts 的 anchorGlob：不以 ** 或 / 开头的 glob 锚定到搜索根
const anchorGlob = (glob: string) => (glob.startsWith('**') || glob.startsWith('/') ? glob : `/${glob}`)
// include/exclude 共用的 glob 归一化：字符串或数组、去前导 !、正斜杠、去重、限长限量
const normalizeGlobs = (v: unknown): string[] => [
  ...new Set(
    (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim().replace(/^!+/, '').replace(/\\/g, '/').slice(0, 260))
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

// 按行切分流式输出（块边界可能切在行中间）
function lineSplitter(onLine: (line: string) => void) {
  let buf = ''
  return {
    push(chunk: Buffer) {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.trim()) onLine(line)
      }
    },
    end() {
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
const clampLine = (text: string, ranges: Array<[number, number]>): { text: string; ranges: Array<[number, number]> } => {
  if (text.length <= MAX_LINE_CHARS) return { text, ranges }
  const first = ranges[0]?.[0] ?? 0
  const start = Math.max(0, Math.min(first - 100, text.length - MAX_LINE_CHARS))
  const end = start + MAX_LINE_CHARS
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const shifted = ranges
    .filter(([a, b]) => b > start && a < end)
    .map(([a, b]) => [Math.max(a, start) - start + prefix.length, Math.min(b, end) - start + prefix.length] as [number, number])
  return { text: prefix + text.slice(start, end) + suffix, ranges: shifted }
}

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

// 文件名匹配用 JS 正则（rg 的 Rust 正则与 JS 有差异；编译失败就跳过文件名命中）
// regex 模式支持 \Q...\E（转成 JS 转义文本）；literal 模式直接转义整段文本。
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const unquote = (s: string) => s.replace(/\\Q([\s\S]*?)\\E/g, (_, lit: string) => escapeRegExp(lit))
const nameRegex = (pattern: string, mode: 'literal' | 'regex', ignoreCase: boolean): RegExp | null => {
  let src = pattern
  let flags = ignoreCase ? 'giu' : 'gu'
  if (mode === 'regex' && src.startsWith('(?i)')) {
    src = src.slice(4)
    flags = 'giu'
  }
  src = mode === 'literal' ? escapeRegExp(src) : unquote(src)
  for (const f of [flags, flags.replace('u', ''), flags.replace('gu', 'g')]) {
    try {
      return new RegExp(src, f)
    } catch {
      // 尝试下一个 flags
    }
  }
  return null
}
interface NameOpts {
  mode: 'literal' | 'regex'
  ignoreCase: boolean
  wholeWord: boolean
}
const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch)
// 在 basename 上匹配，但返回整条显示路径中的区间（前端高亮用）
const nameRangesOf = (display: string, pattern: string, opts: NameOpts): Array<[number, number]> | undefined => {
  const baseStart = display.lastIndexOf('/') + 1
  const base = display.slice(baseStart)
  const re = nameRegex(pattern, opts.mode, opts.ignoreCase)
  if (!re) return undefined
  const ranges: Array<[number, number]> = []
  for (const m of base.matchAll(re)) {
    if (!m[0] || m.index === undefined) continue
    const end = m.index + m[0].length
    if (opts.wholeWord && (isWordChar(base[m.index - 1]) || isWordChar(base[end]))) continue
    ranges.push([baseStart + m.index, baseStart + end])
  }
  return ranges.length ? ranges : undefined
}

interface NameScan {
  hits: Map<string, SearchFile>
  truncated: boolean
  timedOut: boolean
  error?: string
}

// rg --files 流式枚举文件名；路径是文件时直接检查 basename
function scanNames(abs: string, isDir: boolean, cwd: string, pattern: string, nameOpts: NameOpts, maxHits: number, timeoutMs: number, rg: string, includes: string[], excludes: string[]): Promise<NameScan> {
  const hits = new Map<string, SearchFile>()
  if (!isDir) {
    const display = displayPath(cwd, abs)
    const ranges = nameRangesOf(display, pattern, nameOpts)
    if (ranges) hits.set(display, { path: display, nameMatch: true, nameRanges: ranges, matches: [] })
    return Promise.resolve({ hits, truncated: false, timedOut: false })
  }
  return new Promise((resolve) => {
    let settled = false
    let truncated = false
    let timedOut = false
    let stopped = false
    let stderr = ''
    // 显式指定单个文件时不套用 ignore/include/exclude/hidden（用户就是要搜这个文件）
    const args = isDir
      ? [
          '--files',
          '--hidden',
          '--no-config',
          '--no-require-git',
          ...includes.flatMap((g) => ['--glob', g]),
          ...excludes.flatMap((g) => ['--glob', `!${g}`]),
          '--',
          abs,
        ]
      : ['--files', '--no-config', '--', abs]
    const child = spawn(rg, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ hits, truncated, timedOut, ...(stderr.trim() ? { error: stderr.trim() } : {}) })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const split = lineSplitter((line) => {
      if (stopped || hits.size >= maxHits) return
      const display = displayPath(cwd, line)
      const ranges = nameRangesOf(display, pattern, nameOpts)
      if (!ranges) return
      hits.set(display, { path: display, nameMatch: true, nameRanges: ranges, matches: [] })
      if (hits.size >= maxHits) {
        stopped = true
        truncated = true
        child.kill()
      }
    })
    child.stdout.on('data', (chunk: Buffer) => split.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (err) => {
      stderr = err.message
      finish()
    })
    child.on('close', () => {
      split.end()
      finish()
    })
  })
}

interface ContentScan {
  files: Map<string, SearchFile>
  total: number
  truncated: boolean
  timedOut: boolean
  nonUtf8: boolean
  error?: string
}

// rg --json 流式内容搜索；达到 remaining 或超时 kill
function scanContent(pattern: string, abs: string, cwd: string, remaining: number, timeoutMs: number, rg: string, isDir: boolean, includes: string[], excludes: string[], opts: { mode: 'literal' | 'regex'; ignoreCase: boolean; wholeWord: boolean; context: number; encoding?: string }): Promise<ContentScan> {
  return new Promise((resolve) => {
    const files = new Map<string, SearchFile>()
    let total = 0
    let settled = false
    let truncated = false
    let timedOut = false
    let stopped = false
    let nonUtf8 = false
    let stderr = ''
    let exited: number | null = null
    // 显式指定单个文件时不套用 ignore/include/exclude/hidden；模式/大小写/编码仍然生效
    const common = [
      '--json',
      '--crlf',
      '--no-config',
      opts.ignoreCase ? '--ignore-case' : '--case-sensitive',
      ...(opts.wholeWord ? ['--word-regexp'] : []),
      ...(opts.mode === 'regex' ? ['--engine', 'auto'] : ['--fixed-strings']),
      ...(opts.context > 0 ? ['--before-context', String(opts.context), '--after-context', String(opts.context)] : []),
      ...(opts.encoding ? ['--encoding', opts.encoding] : []),
    ]
    const globArgs = [
      ...includes.flatMap((g) => ['--glob', g]),
      ...excludes.flatMap((g) => ['--glob', `!${g}`]),
    ]
    const args = isDir
      ? [...common, '--hidden', '--no-require-git', ...globArgs, '--', pattern, abs]
      : [...common, '--', pattern, abs]
    const child = spawn(rg, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 行号排序 + 去重（相邻命中的上下文可能重叠；同一行优先保留命中行）
      for (const file of files.values()) {
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
      }
      const err = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
      resolve({
        files,
        total,
        truncated,
        timedOut,
        nonUtf8,
        ...(exited === 2 || (err && total === 0) ? { error: err || 'rg 执行失败' } : {}),
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
      const display = displayPath(cwd, p)
      const file = files.get(display) ?? { path: display, matches: [] as SearchLine[] }
      if (type === 'context') {
        const clamped = clampLine(text, [])
        file.matches.push({ line: Number(data.line_number) || 0, text: clamped.text, ranges: [], count: 0, kind: 'context' })
        files.set(display, file)
        return
      }
      const map = offsetMap(text)
      // rg 对某些正则不会给出 submatches：退化为整行首个字符，保证有高亮与计数
      const subs = Array.isArray(data.submatches) && data.submatches.length
        ? data.submatches
        : [{ start: 0, end: 1, match: { text: text.slice(0, 1) } }]
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
      if (!ranges.length) ranges.push([0, Math.min(1, text.length)])
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
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (err) => {
      stderr = err.message
      finish()
    })
    child.on('close', (code) => {
      exited = code
      split.end()
      finish()
    })
  })
}

export async function searchTool(args: {
  pattern?: unknown
  mode?: unknown
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
  const pattern = String(args.pattern ?? '')
  if (!pattern) return fail('搜索失败: 缺少 pattern')
  const cwd = resolveCwd(args.cwd)
  if ('error' in cwd) return fail(`搜索失败: ${cwd.error}`)
  // include/exclude：用户 glob；应用时 include 直接传，exclude 与默认排除合并，并按 anchorGlob 锚定。
  const userIncludes = normalizeGlobs(args.include)
  const includeGlobs = userIncludes.map(anchorGlob)
  const userExcludes = normalizeGlobs(args.exclude)
  const excludeGlobs = [...new Set([...DEFAULT_EXCLUDES, ...userExcludes.map(anchorGlob)])]
  const target = String(args.path ?? '.').trim() || '.'
  const abs = path.resolve(cwd.dir, target)
  let isDir = false
  try {
    const st = fs.statSync(abs)
    isDir = st.isDirectory()
    if (!isDir && !st.isFile()) return fail(`搜索失败: 不是文件或目录: ${abs}`)
  } catch {
    return fail(`搜索失败: 路径不存在: ${abs}`)
  }
  const toInt = (v: unknown, def: number) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n > 0 ? n : def
  }
  const maxResults = Math.min(toInt(args.max_results, DEFAULT_MAX_RESULTS), MAX_RESULTS_LIMIT)
  const timeoutS = Math.min(toInt(args.timeout, DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
  const deadline = Date.now() + timeoutS * 1000
  const remainingMs = () => Math.max(1, deadline - Date.now())
  const encoding = typeof args.encoding === 'string' && /^[A-Za-z0-9._-]+$/.test(args.encoding.trim()) ? args.encoding.trim().slice(0, 32) : undefined
  const mode: 'literal' | 'regex' = args.mode === 'regex' ? 'regex' : 'literal'
  const flagStr = typeof args.flags === 'string' ? args.flags.toLowerCase() : Array.isArray(args.flags) ? args.flags.join('').toLowerCase() : ''
  const ignoreCase = flagStr.includes('i')
  const wholeWord = flagStr.includes('w')
  const ctxRaw = Math.floor(Number(args.context))
  const contextLines = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.min(ctxRaw, 20) : 0
  const nameOpts: NameOpts = { mode, ignoreCase, wholeWord }
  const rg = await resolveRg()

  // 文件名命中最多占 1/4 预算，避免文件名匹配把内容结果挤掉
  const nameBudget = Math.max(1, Math.floor(maxResults / 4))
  const names = await scanNames(abs, isDir, cwd.dir, pattern, nameOpts, nameBudget, remainingMs(), rg, includeGlobs, excludeGlobs)
  const remaining = maxResults - names.hits.size
  const content: ContentScan = remaining > 0
    ? await scanContent(pattern, abs, cwd.dir, remaining, remainingMs(), rg, isDir, includeGlobs, excludeGlobs, { mode, ignoreCase, wholeWord, context: contextLines, encoding })
    : { files: new Map<string, SearchFile>(), total: 0, truncated: true, timedOut: false, nonUtf8: false }

  // 内容命中与文件名命中合并：同一文件只出现一次
  const files = [...content.files.values()]
  for (const [p, hit] of names.hits) {
    const existing = content.files.get(p)
    if (existing) {
      existing.nameMatch = true
      existing.nameRanges = hit.nameRanges
    } else {
      files.push(hit)
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  const root = displayPath(cwd.dir, abs)
  const result: SearchResult = {
    pattern,
    root,
    files,
    totalMatches: content.total,
    nameHits: names.hits.size,
    truncated: content.truncated || names.truncated || remaining <= 0,
    limit: maxResults,
    ...(content.nonUtf8 ? { nonUtf8: true } : {}),
    ...(contextLines ? { context: contextLines } : {}),
    ...(userIncludes.length ? { include: userIncludes } : {}),
    ...(userExcludes.length ? { exclude: userExcludes } : {}),
    ...(content.timedOut || names.timedOut ? { timedOut: true } : {}),
  }

  const err = content.error ?? (content.total === 0 ? names.error : undefined)
  if (err) return { text: clipMiddle(`搜索失败: ${err}`, MAX_TEXT_CHARS), isError: true }

  const filters = [
    userIncludes.length ? `仅：${userIncludes.join('、')}` : '',
    userExcludes.length ? `排除：${userExcludes.join('、')}` : '',
  ].filter(Boolean)
  const header = `[搜索] ${pattern} 于 ${root}${filters.length ? `（${filters.join('；')}）` : ''}`
  const lines: string[] = [header]
  if (!files.length) {
    lines.push('未找到匹配')
  } else {
    for (const file of files) {
      const nameTag = file.nameMatch ? '  [文件名命中]' : ''
      const fileCount = file.matches.reduce((n, m) => n + (m.kind === 'context' ? 0 : (m.count ?? m.ranges.length)), 0)
      const count = fileCount ? `  (${fileCount})` : ''
      lines.push(`${file.path}${nameTag}${count}`)
      let prevLine = -1
      for (const m of file.matches) {
        if (prevLine >= 0 && m.line > prevLine + 1) lines.push('      ...')
        const sep = m.kind === 'context' ? '-' : ':'
        lines.push(`${String(m.line).padStart(5)}${sep} ${m.text}`)
        prevLine = m.line
      }
    }
  }
  const totalResults = content.total + names.hits.size
  const breakdown = names.hits.size ? `（${content.total} 处内容 + ${names.hits.size} 个文件名命中）` : ''
  const nonUtf8Hint = content.nonUtf8 ? '，含非 UTF-8 内容（建议指定 encoding）' : ''
  lines.push(
    `[${files.length} 个文件，${totalResults} 个结果${breakdown}${result.timedOut ? '，搜索超时' : ''}${nonUtf8Hint}]`,
  )
  if (result.truncated) lines.push(`[已截断] 已显示 ${totalResults} 个结果（上限 ${maxResults}）`)
  const timedOut = content.timedOut || names.timedOut
  return {
    text: clipMiddle(lines.join('\n'), MAX_TEXT_CHARS),
    search: result,
    isError: timedOut,
    durationMs: Date.now() - startedAt,
  }
}
