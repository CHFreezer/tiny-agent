import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.ts'

// ===== 会话图片：以文件存放在 <DATA_DIR>/sessions/<会话id>/，条目/事件里只存 URL =====
// - 前端 <img src> 直接用这个 URL；发给上游时再读回 data URL（OpenAI 协议只认 URL 或 base64，
//   本机服务器通常也不可被上游访问，所以那一份 base64 省不掉——但磁盘、会话 JSON、WS、文本流都不再带它）
// - 文件名 = 内容 sha256 前 16 位 + 扩展名：同一张图重复发送只落一份，内容寻址 → 可 immutable 长缓存
// - 落盘与回收都收口在本模块：写入即落盘；saveSession 后清理未被引用的；删会话时整目录删除

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const NAME_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp|bmp)$/
const URL_RE = /^\/api\/sessions\/(\d+)\/files\/([^/]+)$/
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

// 图片元信息：发给上游用的 data URL + 格式/字节数/宽高（宽高解析失败时省略）
export interface ImageInfo {
  url: string
  mime: string
  bytes: number
  width?: number
  height?: number
}

const sessionDir = (sessionId: number) => path.join(SESSIONS_DIR, String(sessionId))

// 图片名 → 磁盘路径；只认 <16位hex>.<白名单后缀>，从名字层面杜绝目录穿越
export function resolveImage(sessionId: number, name: string): string | undefined {
  if (!NAME_RE.test(name)) return undefined
  const file = path.join(sessionDir(sessionId), name)
  return fs.existsSync(file) ? file : undefined
}

// data URL → 落盘，返回条目里要存的 URL；已是 URL 或类型不认识的，原样返回（继续内联，不静默丢内容）
export function storeImage(sessionId: number, src: string): string {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(src)
  const ext = m ? EXT_BY_MIME[m[1].toLowerCase()] : undefined
  if (!m || !ext) return src
  const buf = Buffer.from(m[2], 'base64')
  const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`
  const dir = sessionDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf) // 内容寻址：同名即同内容，重复发送不重写
  return `/api/sessions/${sessionId}/files/${name}`
}

// URL / data URL → 可发给上游的 data URL + 元信息（格式/字节数/宽高）
export function imageInfo(src: string): ImageInfo {
  const m = URL_RE.exec(src)
  if (m) {
    const file = resolveImage(Number(m[1]), m[2])
    if (!file) return { url: src, mime: 'application/octet-stream', bytes: 0 }
    const buf = fs.readFileSync(file)
    const mime = MIME_BY_EXT[m[2].slice(m[2].lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
    return { url: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length, ...dimensions(buf) }
  }
  const d = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(src)
  if (d) {
    const buf = Buffer.from(d[2], 'base64')
    return { url: src, mime: d[1], bytes: buf.length, ...dimensions(buf) }
  }
  return { url: src, mime: 'application/octet-stream', bytes: 0 }
}

// URL → data URL：仅转换本服务自己发的图片 URL，其他 URL 原样透传（上游可能自己会取）
export const toDataUrl = (src: string) => imageInfo(src).url

// 只读格式头拿宽高：PNG / GIF / BMP / WebP / JPEG；解析失败返回 {}（不影响发图）
function dimensions(buf: Buffer): { width?: number; height?: number } {
  try {
    // PNG：签名 + IHDR（宽高各 4 字节大端）
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // GIF：逻辑屏幕宽高（小端 2 字节）
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    // BMP：宽高为小端 int32（高度可能为负，表示自上而下）
    if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
    }
    // WebP：RIFF....WEBP，按首个 chunk 的布局解析（VP8X / VP8 / VP8L）
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)) }
      }
    }
    // JPEG：扫描 SOF 段（排除 DHT/JPG/DAC）
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        if (marker === 0xff) {
          i++
          continue
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2
          continue
        }
        const len = buf.readUInt16BE(i + 2)
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        if (len < 2) break
        i += 2 + len
      }
    }
  } catch {
    // 头部不完整/格式异常：忽略元信息
  }
  return {}
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
