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

// URL → data URL：仅转换本服务自己发的图片 URL，其他 URL 原样透传（上游可能自己会取）
export function toDataUrl(src: string): string {
  const m = URL_RE.exec(src)
  if (!m) return src
  const file = resolveImage(Number(m[1]), m[2])
  if (!file) return src
  const mime = MIME_BY_EXT[m[2].slice(m[2].lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
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
