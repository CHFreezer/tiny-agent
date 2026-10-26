import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { DATA_DIR } from './config.ts'

// ===== 会话图片：以文件存放在 <DATA_DIR>/sessions/<会话id>/，条目/事件里只存 URL =====
// - 前端 <img src> 直接用这个 URL；发给上游时再读回 data URL（OpenAI 协议只认 URL 或 base64，
//   本机服务器通常也不可被上游访问，所以那一份 base64 省不掉——但磁盘、会话 JSON、WS、文本流都不再带它）
// - 入图先用 sharp 严格解码，再统一转成 PNG（动图转 GIF）；转发上游的 base64 就是转换后的结果
// - 文件名 = n + 内容 sha256 前 16 位 + 扩展名：n 表示已规范化（或可信 Playwright PNG），读取时跳过重编码
// - 落盘与回收都收口在本模块：写入即落盘；saveSession 后清理未被引用的；删会话时整目录删除

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const NAME_RE = /^(n?[a-f0-9]{16})\.(png|jpg|gif|webp|bmp)$/
const URL_RE = /^\/api\/sessions\/(\d+)\/files\/([^/]+)$/
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 只靠文件头识别常见位图格式；空文件/损坏文件/未知格式返回 undefined
export function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6)
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif'
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.length >= 14 && buf.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
  return undefined
}

export interface NormalizedImage {
  data: Buffer
  mime: 'image/png' | 'image/gif'
  width: number
  height: number
}

// 严格解码（失败返回 null），静态图统一 PNG，动图保留帧并转 GIF；EXIF 方向会烘焙进静态图
export async function normalizeImage(buf: Buffer): Promise<NormalizedImage | null> {
  try {
    const input = sharp(buf, { animated: true, failOn: 'warning' })
    const meta = await input.metadata()
    if (!meta.width || !meta.height) return null
    const animated = (meta.pages ?? 1) > 1
    const data = animated ? await input.gif().toBuffer() : await input.rotate().png().toBuffer()
    if (!data.length) return null
    const out = await sharp(data, { animated: true }).metadata()
    if (!out.width || !out.height) return null
    return {
      data,
      mime: animated ? 'image/gif' : 'image/png',
      width: out.width,
      height: out.pageHeight ?? out.height,
    }
  } catch {
    return null
  }
}

// 图片元信息：发给上游用的 data URL + 格式/字节数/宽高
export interface ImageInfo {
  url: string
  mime: string
  bytes: number
  width?: number
  height?: number
}

const sessionDir = (sessionId: number) => path.join(SESSIONS_DIR, String(sessionId))
const invalidInfo = (src: string): ImageInfo => ({ url: src, mime: 'application/octet-stream', bytes: 0 })

// 图片名 → 磁盘路径；只认 n?<16位hex>.<白名单后缀>，从名字层面杜绝目录穿越
export function resolveImage(sessionId: number, name: string): string | undefined {
  if (!NAME_RE.test(name)) return undefined
  const file = path.join(sessionDir(sessionId), name)
  return fs.existsSync(file) ? file : undefined
}

// data URL → 严格解码 → PNG/GIF 落盘，返回条目里要存的 URL；已是 URL 的原样返回
// trustPng：Playwright 截图是可信 PNG，跳过 sharp 重编码，原样落盘
export async function storeImage(sessionId: number, src: string, opts?: { trustPng?: boolean }): Promise<string> {
  if (!src.startsWith('data:')) return src
  const m = DATA_URL_RE.exec(src)
  if (!m) throw new Error('不是有效的图片')
  const buf = Buffer.from(m[2], 'base64')
  const mime = sniffImageMime(buf)
  if (!mime || !SUPPORTED.has(mime)) throw new Error('不支持的图片格式（仅支持 png/jpg/webp/gif）')
  if (opts?.trustPng && mime === 'image/png') {
    const name = `n${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.png`
    const dir = sessionDir(sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
    return `/api/sessions/${sessionId}/files/${name}`
  }
  const img = await normalizeImage(buf)
  if (!img) throw new Error('图片无法解码（文件可能已损坏）')
  const ext = EXT_BY_MIME[img.mime]
  const name = `n${createHash('sha256').update(img.data).digest('hex').slice(0, 16)}.${ext}`
  const dir = sessionDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, img.data) // 内容寻址：同名即同内容，重复发送不重写
  return `/api/sessions/${sessionId}/files/${name}`
}

// URL / data URL → 严格解码后的 data URL + 元信息；损坏/空文件返回 invalid（上游会跳过）
export async function imageInfo(src: string): Promise<ImageInfo> {
  let buf: Buffer
  let trusted = false
  const m = URL_RE.exec(src)
  if (m) {
    trusted = m[2].startsWith('n') && (m[2].endsWith('.png') || m[2].endsWith('.gif'))
    const file = resolveImage(Number(m[1]), m[2])
    if (!file) return invalidInfo(src)
    try {
      buf = fs.readFileSync(file)
    } catch {
      return invalidInfo(src)
    }
  } else {
    const d = DATA_URL_RE.exec(src)
    if (!d) return invalidInfo(src)
    buf = Buffer.from(d[2], 'base64')
  }
  const mime = sniffImageMime(buf)
  if (!mime) return invalidInfo(src)
  // n 前缀是规范化后的文件；Playwright PNG 也走这里，直接原样转发，只读头部拿宽高
  if (trusted && (mime === 'image/png' || mime === 'image/gif')) {
    try {
      const meta = await sharp(buf, { animated: true }).metadata()
      if (!meta.width || !meta.height) return invalidInfo(src)
      return {
        url: `data:${mime};base64,${buf.toString('base64')}`,
        mime,
        bytes: buf.length,
        width: meta.width,
        height: meta.pageHeight ?? meta.height,
      }
    } catch {
      return invalidInfo(src)
    }
  }
  const img = await normalizeImage(buf)
  if (!img) return invalidInfo(src)
  return {
    url: `data:${img.mime};base64,${img.data.toString('base64')}`,
    mime: img.mime,
    bytes: img.data.length,
    width: img.width,
    height: img.height,
  }
}

// 清理不再被任何条目引用的图片（saveSession 后调用）
export function sweepImages(sessionId: number, entries: Array<{ images?: string[] }>): void {
  let names: string[]
  try {
    names = fs.readdirSync(sessionDir(sessionId))
  } catch {
    return // 该会话还没写过图片
  }
  const keep = new Set<string>()
  for (const e of entries) for (const u of e.images ?? []) keep.add(u.slice(u.lastIndexOf('/') + 1))
  for (const n of names) if (!keep.has(n)) fs.rmSync(path.join(sessionDir(sessionId), n), { force: true })
}

// 删会话：整目录删除
export const removeImages = (sessionId: number) => fs.rmSync(sessionDir(sessionId), { recursive: true, force: true })
