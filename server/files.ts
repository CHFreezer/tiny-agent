import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { diff as nodeDiff } from 'node:util'
import iconv from 'iconv-lite'
import { WORKSPACE_DIR, errMsg } from './config.ts'
import type { DiffBlock, DiffLine, EditDiff, ToolResult } from './types.ts'

// ===== 文件工具：read（文本/十六进制）与 edit（单区间严格编辑） =====
// read：encoding 默认 utf-8（按行号输出），encoding:"hex" 输出 HxD 风格十六进制。
// edit：一次只改一个区间。文本用 line + old/new 字符串；encoding:"hex" 时 offset=字节偏移 + old/new 十六进制字节。
// 校验：文本在原始字节中精确查找 old；hex 在 offset 处做 sha256 校验，不一致拒绝。
const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_CHARS = 2000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_EDIT_BYTES = 64 * 1024 * 1024
const HEX_DEFAULT_BYTES = 1024
const HEX_MAX_BYTES = 4096
const MAX_DIFF_CHARS = 8000 // 工具结果里回给模型的 diff 文本上限

const toAbs = (p: string) => path.resolve(WORKSPACE_DIR, p)
const normalizeEncoding = (v: unknown) => String(v ?? 'utf-8').trim().toLowerCase() || 'utf-8'
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

// 统一校验：raw[offset .. offset+old.length) 必须与 old 完全一致（sha256）
function verifyOldBytes(raw: Buffer, offset: number, old: Buffer, label: string): void {
  if (offset < 0 || offset + old.length > raw.length) {
    throw new Error(`${label} 超出文件末尾（文件 ${raw.length} 字节）`)
  }
  if (sha256(raw.subarray(offset, offset + old.length)) !== sha256(old)) {
    throw new Error(`${label} 的原始字节 hash 与 old 不一致，拒绝编辑`)
  }
}

// ===== read =====
// encoding：缺省 utf-8；"hex" 走十六进制；其余交给 TextDecoder（gbk/gb18030/big5/shift_jis/euc-kr/utf-16le 等）
export function readTool(args: { path?: unknown; encoding?: unknown; line?: unknown; offset?: unknown; limit?: unknown }): ToolResult {
  const raw = String(args.path ?? '').trim()
  if (!raw) return { text: '读取失败: 缺少 path' }
  const abs = toAbs(raw)
  const encoding = normalizeEncoding(args.encoding)
  const hasOffset = args.offset !== undefined && args.offset !== null && args.offset !== ''
  const hasLine = args.line !== undefined && args.line !== null && args.line !== ''
  if (encoding === 'hex' && hasLine) return { text: '读取失败: hex 模式请用 offset，line 仅用于文本模式' }
  if (encoding !== 'hex' && hasOffset) return { text: '读取失败: 文本模式请用 line，offset 仅用于 hex 模式' }
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return { text: `读取失败: 不是文件: ${abs}` }
    if (encoding === 'hex') return readHex(abs, st.size, args)
    if (st.size > MAX_FILE_BYTES) return { text: `读取失败: 文件过大（${st.size} 字节，上限 ${MAX_FILE_BYTES}）: ${abs}` }
    const buf = fs.readFileSync(abs)
    // 文本编码里只有 UTF-16/32 正常含 NUL；其它编码含 NUL 基本可以判定是二进制
    const nulAllowed = /^utf-?(16|32)/.test(encoding)
    if (!nulAllowed && buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
      return { text: `读取失败: 二进制文件（含 NUL）；查看原始字节请用 encoding:"hex": ${abs}` }
    }
    let text: string
    const enc = resolveEncoding(encoding, buf)
    try {
      text = new TextDecoder(enc, { fatal: true }).decode(buf)
    } catch (err) {
      if (err instanceof RangeError) {
        // TextDecoder 不认识的标签（UTF-32、CP932、CP949 等）交给 iconv
        try {
          text = iconv.decode(buf, enc)
        } catch {
          return { text: `读取失败: 不支持的编码: ${encoding}` }
        }
      } else {
        return { text: `读取失败: 无法按 ${encoding} 解码` }
      }
    }
    const spec = eolSpecOf(encoding, buf)
    text = stripBomText(text, buf, spec)
    const lines = splitTextLines(text)
    const total = lines.length
    const offset = Math.max(1, Math.floor(Number(args.line)) || 1)
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(args.limit)) || MAX_READ_LINES))
    if (total === 0) return { text: `(文件为空: ${abs})` }
    if (offset > total) return { text: `line=${offset} 超出范围（文件共 ${total} 行）: ${abs}` }
    const out: string[] = []
    let bytes = 0
    for (let i = offset - 1; i < total && out.length < limit; i++) {
      // Claude Code 的 cat -n 风格：行号右对齐 6 位 + Tab
      const entry = `${String(i + 1).padStart(6)}\t${clampLine(lines[i])}`
      const size = Buffer.byteLength(entry, 'utf8') + 1
      if (out.length > 0 && bytes + size > MAX_READ_BYTES) break
      out.push(entry)
      bytes += size
    }
    const end = offset + out.length - 1
    const footer = end < total ? `\n[共 ${total} 行，已显示 ${offset}-${end}；继续读取请用 line=${end + 1}]` : `\n[共 ${total} 行]`
    return { text: out.join('\n') + footer }
  } catch (err) {
    return { text: `读取失败: ${errMsg(err)}` }
  }
}

// 按码点截断：避免把一个 emoji/生僻字（UTF-16 代理对）劈成两半
const clampLine = (line: string) => {
  if (line.length <= MAX_LINE_CHARS) return line
  let out = ''
  let n = 0
  for (const ch of line) {
    if (n + ch.length > MAX_LINE_CHARS) break
    out += ch
    n += ch.length
  }
  return `${out}... (此行已截断，共 ${line.length} 字符)`
}

// HxD 风格：Offset(h) + 16 字节/行 hex + ASCII（非可打印字节显示 .）
function readHex(abs: string, size: number, args: { offset?: unknown; limit?: unknown }): ToolResult {
  if (size === 0) return { text: `(文件为空: ${abs})` }
  const parsedOffset = parseOffset(args.offset)
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0
  const limit = Math.min(HEX_MAX_BYTES, Math.max(16, Math.floor(Number(args.limit)) || HEX_DEFAULT_BYTES))
  if (offset >= size) return { text: `offset=0x${offset.toString(16).toUpperCase()} 超出范围（文件共 ${size} 字节）: ${abs}` }
  const len = Math.min(limit, size - offset)
  const fd = fs.openSync(abs, 'r')
  const buf = Buffer.alloc(len)
  try {
    fs.readSync(fd, buf, 0, len, offset)
  } finally {
    fs.closeSync(fd)
  }
  const width = Math.max(8, (size - 1).toString(16).length)
  const out: string[] = [`${'Offset(h)'.padEnd(width + 3)}00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F  ASCII`]
  for (let i = 0; i < len; i += 16) {
    const row = buf.subarray(i, i + 16)
    const hex = Array.from(row, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ').padEnd(47)
    const ascii = Array.from(row, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('')
    out.push(`${(offset + i).toString(16).toUpperCase().padStart(width, '0')}   ${hex}  ${ascii}`)
  }
  const end = offset + len
  const total = size.toString(16).toUpperCase()
  const footer = end < size
    ? `[共 ${size} 字节 (0x${total})，已显示 0x${offset.toString(16).toUpperCase()}-0x${(end - 1).toString(16).toUpperCase()}；继续读取请用 offset=0x${end.toString(16).toUpperCase()}]`
    : `[共 ${size} 字节 (0x${total})，已显示到文件末尾]`
  return { text: out.join('\n') + '\n' + footer }
}

// ===== edit =====
// 字符串 → 目标编码字节（UTF-8 用原生 Buffer，其余用 iconv）
const encodeText = (text: string, encoding: string): Buffer => {
  if (encoding === 'utf-8' || encoding === 'utf8') return Buffer.from(text, 'utf8')
  return iconv.encode(text, encoding)
}

const parseHexValue = (v: unknown, name: string): Buffer => {
  const cleaned = String(v ?? '').replace(/0x/gi, ' ').replace(/[\s,]/g, '')
  if (!cleaned) return Buffer.alloc(0)
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error(`${name} 只能包含十六进制字节`)
  if (cleaned.length % 2) throw new Error(`${name} 的十六进制字符数必须是偶数（每字节两位）`)
  return Buffer.from(cleaned, 'hex')
}

// offset 支持数字、十进制字符串、0x 开头的十六进制字符串
const parseOffset = (v: unknown): number => {
  if (typeof v === 'number') return Math.floor(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s.slice(2), 16)
    if (/^\d+$/.test(s)) return Number.parseInt(s, 10)
  }
  return NaN
}

// 字符串 → 目标编码字节；编码器不支持时直接报“不支持的编码”
const encodeTextStrict = (text: string, encoding: string, file: string): Buffer => {
  let buf: Buffer
  try {
    buf = encodeText(text, encoding)
  } catch {
    throw new Error(`不支持的编码: ${encoding}`)
  }
  if (encoding !== 'utf-8' && encoding !== 'utf8') {
    let back: string
    try {
      back = iconv.decode(buf, encoding)
    } catch {
      throw new Error(`不支持的编码: ${encoding}`)
    }
    if (back !== text) throw new Error(`${file}: 编码 ${encoding} 无法表示文本中的部分字符`)
  }
  return buf
}

const readForEdit = (abs: string, file: string): Buffer => {
  const st = fs.statSync(abs)
  if (!st.isFile()) throw new Error(`${file}: 不是文件`)
  if (st.size > MAX_EDIT_BYTES) throw new Error(`${file}: 文件过大（${st.size} 字节，上限 ${MAX_EDIT_BYTES}）`)
  return fs.readFileSync(abs)
}

// ===== diff（展示用）：与 git 对齐 =====
// 行 token = 内容 + 行尾符，行尾变化（LF/CRLF/末尾换行）参与比较；
// 行号只按序列计数，不从字节偏移反推；末尾缺换行按 git 风格单独标记。
interface LineToken {
  text: string
  eol: string // '' = 文件最后一行没有换行符
}
const NO_NEWLINE = 'No newline at end of file'
const MAX_DIFF_LINES = 100_000 // 超大改动不做精细 diff，整块 -/+，避免 Myers 最坏情况

const sameToken = (a: LineToken, b: LineToken) => a.text === b.text && a.eol === b.eol

// 行尾符种类（用 fromCharCode 避免源码里出现裸控制字符）
const EOL_LABEL: Record<string, string> = {
  [String.fromCharCode(13, 10)]: 'CRLF',
  [String.fromCharCode(13)]: 'CR',
  [String.fromCharCode(10)]: 'LF',
}
// 内容相同、只有行尾符不同的 -/+ 行：文本看起来一样，补上行尾符标注
const annotateEol = (blocks: DiffBlock[], eolOf: Map<DiffLine, string>) => {
  for (const b of blocks) {
    const minus = b.lines.filter((l) => l.type === '-' && eolOf.get(l))
    const plus = b.lines.filter((l) => l.type === '+' && eolOf.get(l))
    for (const m of minus) {
      for (const p of plus) {
        if (m.text !== p.text || eolOf.get(m) === eolOf.get(p)) continue
        m.text += ` (${EOL_LABEL[eolOf.get(m)!]})`
        p.text += ` (${EOL_LABEL[eolOf.get(p)!]})`
      }
    }
  }
}

// 按文本换行切分（LF / CRLF / CR）；空文本 0 行；末尾行尾符不产生额外空行
const splitLineTokens = (text: string): LineToken[] => {
  if (text === '') return []
  const parts = text.split(/(\r\n|\r|\n)/)
  const out: LineToken[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i]
    const eol = parts[i + 1]
    if (eol === undefined && body === '') break
    out.push({ text: body, eol: eol ?? '' })
  }
  return out
}
const splitTextLines = (text: string): string[] => splitLineTokens(text).map((t) => t.text)

// diff 用宽松解码：编辑已经成功，文件其他位置有非法字节也不该让 diff 失败
const decodeLenient = (raw: Buffer, encoding: string): string => {
  try {
    return new TextDecoder(encoding).decode(raw)
  } catch {
    try {
      return iconv.decode(raw, encoding)
    } catch {
      return raw.toString('utf8')
    }
  }
}
const stripBomText = (text: string, raw: Buffer, spec: EolSpec): string =>
  spec.bom.length && matchAt(raw, 0, spec.bom) && text.startsWith('\uFEFF') ? text.slice(1) : text

const buildTextDiff = (file: string, oldRaw: Buffer, newRaw: Buffer, encoding: string): EditDiff => {
  const spec = eolSpecOf(encoding, oldRaw)
  const oldTokens = splitLineTokens(stripBomText(decodeLenient(oldRaw, encoding), oldRaw, spec))
  const newTokens = splitLineTokens(stripBomText(decodeLenient(newRaw, encoding), newRaw, spec))

  // 去掉公共前缀/后缀，只 diff 变化区间
  let p = 0
  while (p < oldTokens.length && p < newTokens.length && sameToken(oldTokens[p], newTokens[p])) p++
  let so = oldTokens.length - 1
  let sn = newTokens.length - 1
  while (so >= p && sn >= p && sameToken(oldTokens[so], newTokens[sn])) {
    so--
    sn--
  }
  const oldMid = oldTokens.slice(p, so + 1)
  const newMid = newTokens.slice(p, sn + 1)
  let oldNo = p + 1
  let newNo = p + 1

  // 超大改动退化成整块 -/+
  if (oldMid.length + newMid.length > MAX_DIFF_LINES) {
    const lines: DiffLine[] = []
    const eolOf = new Map<DiffLine, string>()
    for (const t of oldMid) {
      const l: DiffLine = { type: '-', oldNo: oldNo++, text: t.text }
      eolOf.set(l, t.eol)
      lines.push(l)
      if (!t.eol) lines.push({ type: '\\', text: NO_NEWLINE })
    }
    for (const t of newMid) {
      const l: DiffLine = { type: '+', newNo: newNo++, text: t.text }
      eolOf.set(l, t.eol)
      lines.push(l)
      if (!t.eol) lines.push({ type: '\\', text: NO_NEWLINE })
    }
    const blocks = lines.length ? [{ lines }] : []
    annotateEol(blocks, eolOf)
    return { path: file, blocks }
  }

  // 同一个 (内容, 行尾符) 用同一个 id 参与 util.diff（元素级比较只认原始值）
  const dict = new Map<string, LineToken>()
  const idOf = (t: LineToken) => {
    const key = JSON.stringify([t.text, t.eol])
    if (!dict.has(key)) dict.set(key, t)
    return key
  }

  const blocks: DiffBlock[] = []
  const eolOf = new Map<DiffLine, string>()
  let cur: DiffBlock | null = null
  for (const [op, id] of nodeDiff(oldMid.map(idOf), newMid.map(idOf))) {
    if (op === 0) {
      oldNo++
      newNo++
      cur = null
      continue
    }
    if (!cur) {
      cur = { lines: [] }
      blocks.push(cur)
    }
    const t = dict.get(id)!
    const line: DiffLine = op === 1 ? { type: '-', oldNo: oldNo++, text: t.text } : { type: '+', newNo: newNo++, text: t.text }
    cur.lines.push(line)
    eolOf.set(line, t.eol)
    if (!t.eol) cur.lines.push({ type: '\\', text: NO_NEWLINE })
  }
  annotateEol(blocks, eolOf)
  return { path: file, blocks }
}

// 给模型看的 diff 文本：行号/标记/内容与前端一致
const formatDiffText = (diff: EditDiff): string => {
  const lines: string[] = []
  if (diff.kind === 'hex' && diff.offset) lines.push(`offset=${diff.offset}`)
  for (const [bi, b] of diff.blocks.entries()) {
    if (bi > 0) lines.push('')
    for (const l of b.lines) {
      if (diff.kind === 'hex') {
        lines.push(`${l.type} ${l.text}`)
      } else {
        const no = l.type === '+' ? l.newNo : l.oldNo
        const mark = l.type === ' ' ? ' ' : l.type
        lines.push(`${String(no ?? '').padStart(4)} ${mark} ${l.text}`)
      }
    }
  }
  const text = lines.join('\n')
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)` : text
}

// 不同编码的换行 code unit 与 BOM：按 unit 对齐扫描，避免 UTF-16/32 在奇数字节上误判
interface EolSpec {
  unit: number
  cr: number[]
  lf: number[]
  bom: number[]
}
const matchAt = (raw: Buffer, at: number, pat: number[]) => {
  if (at < 0 || at + pat.length > raw.length) return false
  for (let i = 0; i < pat.length; i++) if (raw[at + i] !== pat[i]) return false
  return true
}
const eolSpecOf = (encoding: string, raw: Buffer): EolSpec => {
  const e = encoding.replace(/[_-]/g, '')
  if (e === 'utf16le') return { unit: 2, lf: [0x0a, 0x00], cr: [0x0d, 0x00], bom: [0xff, 0xfe] }
  if (e === 'utf16be') return { unit: 2, lf: [0x00, 0x0a], cr: [0x00, 0x0d], bom: [0xfe, 0xff] }
  if (e === 'utf16') {
    return matchAt(raw, 0, [0xfe, 0xff])
      ? { unit: 2, lf: [0x00, 0x0a], cr: [0x00, 0x0d], bom: [0xfe, 0xff] }
      : { unit: 2, lf: [0x0a, 0x00], cr: [0x0d, 0x00], bom: [0xff, 0xfe] }
  }
  if (e === 'utf32le') {
    return { unit: 4, lf: [0x0a, 0, 0, 0], cr: [0x0d, 0, 0, 0], bom: [0xff, 0xfe, 0, 0] }
  }
  if (e === 'utf32be') {
    return { unit: 4, lf: [0, 0, 0, 0x0a], cr: [0, 0, 0, 0x0d], bom: [0, 0, 0xfe, 0xff] }
  }
  if (e === 'utf32') {
    return matchAt(raw, 0, [0, 0, 0xfe, 0xff])
      ? { unit: 4, lf: [0, 0, 0, 0x0a], cr: [0, 0, 0, 0x0d], bom: [0, 0, 0xfe, 0xff] }
      : { unit: 4, lf: [0x0a, 0, 0, 0], cr: [0x0d, 0, 0, 0], bom: [0xff, 0xfe, 0, 0] }
  }
  return {
    unit: 1,
    lf: [0x0a],
    cr: [0x0d],
    bom: e === 'utf8' ? [0xef, 0xbb, 0xbf] : [],
  }
}

// 没有显式端序的 utf-16/utf-32：按 BOM 决定实际端序（默认 LE），用于 iconv 编解码
const resolveEncoding = (encoding: string, raw: Buffer): string => {
  const e = encoding.replace(/[_-]/g, '')
  if (e === 'utf16') return matchAt(raw, 0, [0xfe, 0xff]) ? 'utf-16be' : 'utf-16le'
  if (e === 'utf32') return matchAt(raw, 0, [0, 0, 0xfe, 0xff]) ? 'utf-32be' : 'utf-32le'
  return encoding
}

const bomLengthOf = (raw: Buffer, spec: EolSpec) => (spec.bom.length && matchAt(raw, 0, spec.bom) ? spec.bom.length : 0)

// 行首扫描：LF、CRLF（算一个换行）、CR；按编码的 unit 对齐
const scanLineStarts = (raw: Buffer, from: number, spec: EolSpec): number[] => {
  const starts: number[] = [from]
  for (let i = from; i + spec.unit <= raw.length; i += spec.unit) {
    if (matchAt(raw, i, spec.lf)) {
      starts.push(i + spec.lf.length)
      continue
    }
    if (matchAt(raw, i, spec.cr)) {
      const after = i + spec.cr.length
      if (after + spec.unit <= raw.length && matchAt(raw, after, spec.lf)) {
        starts.push(after + spec.lf.length)
        i = after // for 循环再 +unit，跳过 LF
      } else {
        starts.push(after)
      }
    }
  }
  return starts
}
const endsWithEol = (raw: Buffer, spec: EolSpec) =>
  [spec.lf, spec.cr].some((p) => raw.length >= p.length && matchAt(raw, raw.length - p.length, p))

// 文本行起始位置（BOM 跳过）
const textLineStarts = (raw: Buffer, encoding: string) => {
  const spec = eolSpecOf(encoding, raw)
  const bomLen = bomLengthOf(raw, spec)
  return { starts: scanLineStarts(raw, bomLen, spec), bomLen, endsWithNewline: endsWithEol(raw, spec) }
}
const lineCountOfStarts = (raw: Buffer, bomLen: number, endsWithNewline: boolean, starts: number[]) =>
  raw.length <= bomLen ? 0 : starts.length - (endsWithNewline ? 1 : 0)

// 文本编辑：
//   old 非空 = 字节级精确替换（line 可选：从该行行首开始找第一处；replace_all 全部替换）
//   old 为空 = 仅允许填充空文件（文件非空时报错，避免误插入）
// 不做任何换行归一化：LF / CRLF 按 old/new 的实际字符匹配与写入。
function editText(
  abs: string,
  file: string,
  exists: boolean,
  args: { line?: unknown; old: unknown; new: unknown; encoding: string; replaceAll?: unknown },
): ToolResult {
  const encoding = args.encoding
  const oldText = String(args.old ?? '')
  const newText = String(args.new ?? '')
  const replaceAll = args.replaceAll === true
  if (!exists) throw new Error(`${file}: 文件不存在；创建文件请用 write`)
  const raw = readForEdit(abs, file)
  const enc = resolveEncoding(encoding, raw)

  // old 为空/省略 = 插入：不填 line 仅允许空文件；填 line 则把 new 原样插入该行行首
  if (!oldText) {
    const hasLine = args.line !== undefined && args.line !== null && args.line !== ''
    if (!hasLine) {
      if (raw.length > 0) throw new Error(`${file}: 文件非空时插入需要 line；创建文件请用 write`)
      const next = encodeTextStrict(newText, resolveEncoding(encoding, Buffer.alloc(0)), file)
      fs.writeFileSync(abs, next)
      const diff = buildTextDiff(file, raw, next, enc)
      return { text: `Edited ${file}\n${formatDiffText(diff)}`, diff }
    }
    if (!newText) throw new Error(`${file}: 插入需要提供 new 内容`)
    const { starts, bomLen, endsWithNewline } = textLineStarts(raw, enc)
    const lineCount = lineCountOfStarts(raw, bomLen, endsWithNewline, starts)
    const line = Math.floor(Number(args.line))
    if (!Number.isFinite(line) || line < 1 || line > lineCount + 1) {
      throw new Error(`${file}: line=${String(args.line)} 超出范围（1..${lineCount + 1}）`)
    }
    const at = line === lineCount + 1 ? raw.length : starts[line - 1]
    const next = Buffer.concat([raw.subarray(0, at), encodeTextStrict(newText, enc, file), raw.subarray(at)])
    fs.writeFileSync(abs, next)
    const diff = buildTextDiff(file, raw, next, enc)
    return { text: `Edited ${file}\n${formatDiffText(diff)}`, diff }
  }

  const { starts, bomLen, endsWithNewline } = textLineStarts(raw, enc)
  const lineCount = lineCountOfStarts(raw, bomLen, endsWithNewline, starts)

  // line：可选，1-based；从该行行首开始查找 old，用于定位第一处匹配
  let searchFrom = 0
  if (args.line !== undefined && args.line !== null && args.line !== '') {
    const line = Math.floor(Number(args.line))
    if (!Number.isFinite(line) || line < 1 || line > lineCount) {
      throw new Error(`${file}: line=${String(args.line)} 超出范围（文件共 ${lineCount} 行）`)
    }
    searchFrom = starts[line - 1]
  }

  // 严格按模型提供的字符编码成字节；不做 LF/CRLF 转换
  const oldBytes = encodeTextStrict(oldText, enc, file)
  const newBytes = newText === '' ? Buffer.alloc(0) : encodeTextStrict(newText, enc, file)

  const matches: number[] = []
  for (let at = raw.indexOf(oldBytes, searchFrom); at !== -1; at = raw.indexOf(oldBytes, at + oldBytes.length)) {
    matches.push(at)
    if (!replaceAll) break
  }
  if (!matches.length) {
    const where = args.line !== undefined && args.line !== null && args.line !== '' ? ` line=${String(args.line)} 之后` : '文件中'
    throw new Error(`${file}: 找不到 old（按 ${encoding} 编码后在${where}无匹配；检查内容、编码或换行）`)
  }

  const parts: Buffer[] = []
  let last = 0
  for (const at of matches) {
    parts.push(raw.subarray(last, at), newBytes)
    last = at + oldBytes.length
  }
  parts.push(raw.subarray(last))
  const next = Buffer.concat(parts)
  fs.writeFileSync(abs, next)
  const diff = buildTextDiff(file, raw, next, enc)
  return { text: `Edited ${file}\n${formatDiffText(diff)}`, diff }
}

// 二进制编辑：offset 必填；old 为空表示在该偏移插入，new 为空表示删除
function editHex(abs: string, file: string, exists: boolean, args: { offset?: unknown; old: unknown; new: unknown; replaceAll?: unknown }): ToolResult {
  if (args.replaceAll === true) throw new Error('replace_all 不支持 hex 模式')
  const oldBytes = parseHexValue(args.old, 'old')
  const newBytes = parseHexValue(args.new, 'new')
  const hasOffset = args.offset !== undefined && args.offset !== null && args.offset !== ''
  if (!exists) throw new Error(`${file}: 文件不存在；创建文件请用 write`)
  if (!hasOffset) throw new Error(`${file}: hex 模式必须提供 offset（0-based 字节偏移）；创建文件请用 write`)
  const raw = readForEdit(abs, file)
  const offset = parseOffset(args.offset)
  if (!Number.isFinite(offset) || offset < 0 || offset > raw.length) {
    throw new Error(`${file}: offset=${String(args.offset)} 越界（文件 ${raw.length} 字节，范围 0..${raw.length}）`)
  }
  if (oldBytes.length) verifyOldBytes(raw, offset, oldBytes, `${file}: offset=0x${offset.toString(16)}`)
  fs.writeFileSync(abs, Buffer.concat([raw.subarray(0, offset), newBytes, raw.subarray(offset + oldBytes.length)]))
  const hexText = (b: Buffer) => Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ')
  const diff: EditDiff = {
    path: file,
    kind: 'hex',
    offset: `0x${offset.toString(16)}`,
    blocks: [
      {
        lines: [
          ...(oldBytes.length ? [{ type: '-' as const, text: hexText(oldBytes) }] : []),
          ...(newBytes.length ? [{ type: '+' as const, text: hexText(newBytes) }] : []),
        ],
      },
    ],
  }
  return { text: `Edited ${file}\n${formatDiffText(diff)}`, diff }
}

export function editTool(args: { path?: unknown; line?: unknown; offset?: unknown; old?: unknown; new?: unknown; encoding?: unknown; replace_all?: unknown }): ToolResult {
  const file = String(args.path ?? '').trim()
  if (!file) return { text: '编辑失败: 缺少 path' }
  const encoding = normalizeEncoding(args.encoding)
  const abs = toAbs(file)
  try {
    const exists = fs.existsSync(abs)
    const old = args.old ?? ''
    const next = args.new ?? ''
    const hasOffset = args.offset !== undefined && args.offset !== null && args.offset !== ''
    const hasLine = args.line !== undefined && args.line !== null && args.line !== ''
    if (encoding === 'hex' && hasLine) throw new Error('hex 模式请用 offset，line 仅用于文本模式')
    if (encoding !== 'hex' && hasOffset) throw new Error('文本模式请用 line，offset 仅用于 hex 模式')
    if (encoding === 'hex') return editHex(abs, file, exists, { offset: args.offset, old, new: next, replaceAll: args.replace_all })
    return editText(abs, file, exists, { line: args.line, old, new: next, encoding, replaceAll: args.replace_all })
  } catch (err) {
    return { text: `编辑失败: ${errMsg(err)}` }
  }
}

// 创建新文件：目标已存在则失败（修改现有文件用 edit）；文本按 encoding 编码，hex 模式按字节写入
export function writeTool(args: { path?: unknown; content?: unknown; encoding?: unknown }): ToolResult {
  const file = String(args.path ?? '').trim()
  if (!file) return { text: '写入失败: 缺少 path' }
  const encoding = normalizeEncoding(args.encoding)
  const abs = toAbs(file)
  try {
    if (fs.existsSync(abs)) throw new Error(`${file}: 文件已存在；write 只用于创建新文件，修改请用 edit`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (encoding === 'hex') {
      const buf = parseHexValue(args.content, 'content')
      fs.writeFileSync(abs, buf)
      return { text: `Created ${file}` }
    }
    const content = String(args.content ?? '')
    // 新建文件不自动写 BOM；需要 BOM 请用 encoding:"hex" 显式写入
    const next = encodeTextStrict(content, resolveEncoding(encoding, Buffer.alloc(0)), file)
    fs.writeFileSync(abs, next)
    const diff = buildTextDiff(file, Buffer.alloc(0), next, encoding)
    return { text: `Created ${file}`, diff }
  } catch (err) {
    return { text: `写入失败: ${errMsg(err)}` }
  }
}
