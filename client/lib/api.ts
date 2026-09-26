import type { McpServerStatus, Settings, Session } from './types'

export interface SessionsData {
  sessions: Session[]
  currentId: number | null
}

export async function fetchSessions(): Promise<SessionsData> {
  const r = await fetch('/api/sessions')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}


export async function fetchSettings(): Promise<Settings> {
  const r = await fetch('/api/settings')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function putSettings(settings: Settings): Promise<void> {
  const r = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
}

export async function scanModels(base: string, apiKey?: string): Promise<string[]> {
  const r = await fetch('/api/models?base=' + encodeURIComponent(base) + (apiKey ? '&key=' + encodeURIComponent(apiKey) : ''))
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data.models
}

export async function fetchMcp(): Promise<{ servers: McpServerStatus[] }> {
  const r = await fetch('/api/mcp')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function fetchMemories(): Promise<{ memories: string[] }> {
  const r = await fetch('/api/memories')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function putMemories(memories: string[]): Promise<{ memories: string[] }> {
  const r = await fetch('/api/memories', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memories }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function syncMcpServers(): Promise<{ servers: McpServerStatus[] }> {
  const r = await fetch('/api/mcp/sync', { method: 'POST' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}