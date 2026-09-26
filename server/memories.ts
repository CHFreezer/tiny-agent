import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.ts'

// ===== 记忆：持久文本列表，每次生成注入 developer 角色 =====
const MEMORIES_FILE = path.join(DATA_DIR, 'memories.json')
export function readMemories(): string[] {
  try {
    const a = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf8'))
    return Array.isArray(a) ? a.filter((m): m is string => typeof m === 'string' && m.trim().length > 0) : []
  } catch {
    return []
  }
}
// 数组校验由调用方完成（Array.isArray）；写穿并返回清洗后的列表
export function saveMemories(memories: unknown[]): string[] {
  const clean = memories
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, 50)
    .map((m) => m.slice(0, 2000))
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(MEMORIES_FILE, JSON.stringify(clean))
  return clean
}