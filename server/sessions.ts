import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './config.ts'
import { removeImages, sweepImages } from './images.ts'
import type { Entry, Session } from './types.ts'

// ===== 会话存储：内存为权威 + 写穿到磁盘（每会话一个文件，_index.json 存 currentId） =====
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const SESSIONS_INDEX = path.join(SESSIONS_DIR, '_index.json')

// 一次性迁移：旧版单文件 sessions.json → 分文件
function migrateLegacySessions(): void {
  const legacy = path.join(DATA_DIR, 'sessions.json')
  try {
    if (!fs.existsSync(legacy)) return
    const { sessions = [], currentId = null } = JSON.parse(fs.readFileSync(legacy, 'utf8')) as {
      sessions?: Session[]
      currentId?: number | null
    }
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    for (const s of sessions) {
      fs.writeFileSync(path.join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify({ ...s, createdAt: s.createdAt || Date.now() }))
    }
    fs.writeFileSync(SESSIONS_INDEX, JSON.stringify({ currentId }))
    fs.unlinkSync(legacy)
  } catch {
    // 旧文件不存在或损坏：忽略
  }
}

export const sessions = new Map<number, Session>()
let currentId: number | null = null
export const getCurrentId = () => currentId

export function loadAll(): void {
  migrateLegacySessions()
  sessions.clear()
  try {
    currentId = (JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')) as { currentId?: number | null }).currentId ?? null
  } catch {
    currentId = null
  }
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json') || f === '_index.json') continue
      try {
        sessions.set(+f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')) as Session)
      } catch {
        // 跳过损坏文件
      }
    }
  } catch {
    // 会话目录不存在
  }
}

export function saveSession(s: Session): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.writeFileSync(path.join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify(s))
  // 图片随条目增删自动回收（调用方保证：先落盘图片再写条目，见 images.ts）
  sweepImages(s.id, s.history)
}

function saveIndex(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.writeFileSync(SESSIONS_INDEX, JSON.stringify({ currentId }))
}

export function listSorted(): Session[] {
  return [...sessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

// 同一会话的任何变更（含在途生成）串行化
const locks = new Map<number, Promise<unknown>>()
export function withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  locks.set(id, run.catch(() => {}))
  return run
}

// ===== 会话操作 =====
export function createSession(): Session {
  const s: Session = {
    id: Date.now(),
    title: '新会话',
    history: [{ id: randomUUID(), role: 'system', content: 'You are a helpful assistant.', ts: Date.now() }],
    createdAt: Date.now(),
  }
  sessions.set(s.id, s)
  saveSession(s)
  currentId = s.id
  saveIndex()
  return s
}

export function switchSession(id: number): boolean {
  if (!sessions.has(id)) return false
  currentId = id
  saveIndex()
  return true
}

export function renameSession(id: number, title: string): Session | null {
  const s = sessions.get(id)
  if (!s) return null
  s.title = title.trim().slice(0, 40)
  saveSession(s)
  return s
}

export function deleteSession(id: number): { sessions: Session[]; currentId: number | null } | null {
  const s = sessions.get(id)
  if (!s) return null
  sessions.delete(id)
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${id}.json`))
  } catch {
    // 文件不存在
  }
  removeImages(id)
  if (currentId === id) {
    const rest = listSorted()
    currentId = rest.length ? rest[0].id : null
  }
  saveIndex()
  return { sessions: listSorted(), currentId }
}

// ===== 条目删除：级联 + 孤儿清理 =====
// 工具调用/工具结果成对绑定：删调用气泡连带删其工具结果（结果可能暂未生成，找不到即可）；删工具结果连带删发出该调用的气泡
export function cascadeDrop(history: Entry[], entry: Entry, drop: Set<string>): void {
  drop.add(entry.id)
  if (entry.role === 'assistant' && entry.tool_calls?.length) {
    const ids = new Set(entry.tool_calls.map((tc) => tc.id))
    for (const e of history) if (e.role === 'tool' && e.tool_call_id && ids.has(e.tool_call_id)) drop.add(e.id)
  } else if (entry.role === 'tool' && entry.tool_call_id) {
    for (const e of history) if (e.role === 'assistant' && e.tool_calls?.some((tc) => tc.id === entry.tool_call_id)) drop.add(e.id)
  }
}
// 气泡被连带删除后，其余工具结果成为孤儿（tool 消息必须配对 tool_calls，否则上游 400），一并清除
export function dropOrphanedTools(history: Entry[], drop: Set<string>): void {
  for (const e of history) {
    if (e.role === 'tool' && e.tool_call_id && !drop.has(e.id)) {
      const parent = history.find((p) => p.role === 'assistant' && p.tool_calls?.some((tc) => tc.id === e.tool_call_id))
      if (!parent || drop.has(parent.id)) drop.add(e.id)
    }
  }
}
// 删除条目（单条/批量共用）：级联 + 孤儿清理；返回 null 表示删除后会话以助手回复开头（上游拒绝首条非 user/system 消息），拒绝执行
export function applyDelete(s: Session, ids: string[]): Entry[] | null {
  const drop = new Set<string>()
  for (const id of ids) {
    const entry = s.history.find((e) => e.id === id)
    if (entry) cascadeDrop(s.history, entry, drop)
  }
  dropOrphanedTools(s.history, drop)
  const remaining = s.history.filter((e) => !drop.has(e.id))
  for (const e of remaining) {
    if (e.role !== 'system') {
      if (e.role === 'assistant') return null
      break
    }
  }
  s.history = remaining
  return remaining
}