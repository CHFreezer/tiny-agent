import { execFileSync, execSync } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import iconv from 'iconv-lite'

// ===== 子进程输出解码 =====
// PowerShell 自身的输出被我们设为 UTF-8，但原生程序（DISM、cmd 工具等）通常按控制台/系统
// 代码页输出，语言/代码页因系统而异。同一条 stdout/stderr 管道可能混合两种编码，
// 所以先尝试整段 UTF-8，失败后按行判定：每行优先 UTF-8，否则回退到探测到的系统代码页。
// 多字节编码（UTF-8 / DBCS）的序列都不包含 0x0A/0x0D，按行/回车切分不会截断字符。
let acpLabel: string | null = null

const cpValue = (n: number | undefined) => (n && n !== 65001 ? `cp${n}` : 'utf-8')

// 控制台输出代码页（pwsh 子进程继承的 console）；失败时查注册表里的系统 OEMCP。
// 两者都拿不到就用 UTF-8 兜底，不假设任何特定语言/编码。
function detectCodePage(): string {
  try {
    const out = String(execSync('chcp', { windowsHide: true, encoding: 'latin1' })).trim()
    const cp = Number(/(\d{3,5})\s*$/.exec(out)?.[1] ?? 0)
    if (cp) return cpValue(cp)
  } catch {
    // 无控制台/无 chcp：继续查注册表
  }
  try {
    const out = String(
      execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], {
        windowsHide: true,
        encoding: 'latin1',
      }),
    )
    const cp = Number(/OEMCP\s+REG_SZ\s+(\d+)/i.exec(out)?.[1] ?? 0)
    if (cp) return cpValue(cp)
  } catch {
    // 注册表也不可用
  }
  return 'utf-8'
}

export function systemEncoding(): string {
  if (acpLabel) return acpLabel
  if (process.platform !== 'win32') {
    acpLabel = 'utf-8'
    return acpLabel
  }
  const label = detectCodePage()
  // iconv 不认识这个代码页时保留字节（latin1），也不猜测具体编码
  acpLabel = iconv.encodingExists(label) ? label : 'latin1'
  return acpLabel
}

const decodeLine = (buf: Buffer): string => (isUtf8(buf) ? buf.toString('utf8') : iconv.decode(buf, systemEncoding()))

export function decodeOutput(buf: Buffer): string {
  if (!buf.length) return ''
  // Windows 工具被重定向时常见的 UTF-16（带 BOM）输出
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return iconv.decode(buf, 'utf-16')
  }
  if (isUtf8(buf)) return buf.toString('utf8')
  // latin1 与字节一一对应：安全地按 '\n' 切分原始字节
  return buf
    .toString('latin1')
    .split('\n')
    .map((line, i) => (i ? '\n' : '') + decodeLine(Buffer.from(line, 'latin1')))
    .join('')
}

// 长前缀里最后一个完整的字符边界（用于没有换行的实时输出：宁可晚一点，也别把双字节字符劈开）
function safePrefixLen(buf: Buffer, enc: string): number {
  if (isUtf8(buf)) return buf.length
  if (/^cp(932|936|949|950)$/i.test(enc)) {
    let i = 0
    while (i < buf.length) {
      const b = buf[i]
      if (b >= 0x81 && b <= 0xfe) {
        if (i + 1 >= buf.length) return i // 末尾是孤立的前导字节，留到下一块
        i += 2
      } else i += 1
    }
    return buf.length
  }
  return buf.length
}

// 流式解码（实时回显用）：按行/回车成段解码；超长无换行输出按块兜底；
// 空闲时也只刷新到完整字符边界，避免多字节字符被切坏。
export function createLiveDecoder(onText: (text: string) => void, flushBytes = 8192, idleMs = 120) {
  let pending: Buffer = Buffer.alloc(0)
  let timer: NodeJS.Timeout | undefined
  let bomChecked = false
  let utf16: ReturnType<typeof iconv.getDecoder> | null = null
  const textOut = (s: string | undefined) => {
    if (s) onText(s)
  }
  const emit = (segment: Buffer) => {
    if (segment.length) textOut(decodeOutput(segment))
  }
  const flushSafe = () => {
    timer = undefined
    if (!pending.length) return
    const n = safePrefixLen(pending, systemEncoding())
    if (n <= 0) return
    emit(pending.subarray(0, n))
    pending = pending.subarray(n)
  }
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flushSafe, idleMs)
  }
  return {
    write(chunk: Buffer) {
      if (utf16) {
        textOut(utf16.write(chunk))
        return
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      if (!bomChecked) {
        if (pending.length < 2) return // 等够 BOM 再决定编码
        bomChecked = true
        if (pending[0] === 0xff && pending[1] === 0xfe) utf16 = iconv.getDecoder('utf-16le')
        else if (pending[0] === 0xfe && pending[1] === 0xff) utf16 = iconv.getDecoder('utf-16be')
        if (utf16) {
          textOut(utf16.write(pending.subarray(2)))
          pending = Buffer.alloc(0)
          return
        }
      }
      let start = 0
      for (let i = 0; i < pending.length; i++) {
        if (pending[i] === 0x0a || pending[i] === 0x0d) {
          emit(pending.subarray(start, i + 1))
          start = i + 1
        }
      }
      pending = pending.subarray(start)
      if (pending.length >= flushBytes) {
        emit(pending)
        pending = Buffer.alloc(0)
        return
      }
      if (pending.length) arm()
    },
    end() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (utf16) {
        textOut(utf16.end())
        utf16 = null
      }
      if (pending.length) emit(pending)
      pending = Buffer.alloc(0)
    },
  }
}
