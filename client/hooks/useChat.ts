import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type Entry, type Session, type Settings, type ToolCall } from '@/lib/types'
import { fetchSessions, fetchSettings, putSettings, type SessionsData } from '@/lib/api'

// 服务器是会话的唯一所有者：浏览器只发指令、只维护视图镜像
// NDJSON 事件：h=权威历史 a=新assistant条目(位置) id+c/r=增量 id+t=工具片段
// x=工具结果条目(无r=执行占位) e=错误 d=结束(带权威历史)
interface StreamEvent {
  h?: Entry[]
  a?: string
  pos?: number
  id?: string
  c?: string
  r?: string
  t?: { i: number; id?: string; n?: string; a?: string }
  x?: string
  imgs?: string[]
  m?: { id: string; pos?: number; ok?: boolean; err?: string }
  tc?: string
  e?: string
  d?: number
  title?: string
  history?: Entry[]
  usage?: { prompt: number; completion: number; total: number }
  contextTokens?: number
}

export function useChat(effort: string, onError: (message: string) => void) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [serverReady, setServerReady] = useState(false)
  // 流式 UI 状态：genId=当前生成索引所在条目（整轮常驻，a/x 事件移动，d 清除）；executingId=正在执行工具的条目
  const [genId, setGenId] = useState<string | null>(null)
  const [executingId, setExecutingId] = useState<string | null>(null)
  const [lastUsage, setLastUsage] = useState<{ prompt: number; completion: number; total: number } | null>(null)

  const currentSessionIdRef = useRef(currentSessionId)
  currentSessionIdRef.current = currentSessionId
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const serverReadyRef = useRef(serverReady)
  serverReadyRef.current = serverReady
  const effortRef = useRef(effort)
  effortRef.current = effort
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const attachFnRef = useRef<((sid: number) => void) | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // ===== 镜像更新（服务器事实 → 视图状态） =====
  const setHistory = useCallback((id: number, history: Entry[]) => {
    setSessions((x) => x.map((s) => (s.id === id ? { ...s, history } : s)))
  }, [])
  const setHistoryFn = useCallback((id: number, fn: (h: Entry[]) => Entry[]) => {
    setSessions((x) => x.map((s) => (s.id === id ? { ...s, history: fn(s.history) } : s)))
  }, [])
  const patchEntry = useCallback((sessionId: number, entryId: string, patch: Partial<Entry>) => {
    setHistoryFn(sessionId, (h) => h.map((e) => (e.id === entryId ? { ...e, ...patch } : e)))
  }, [setHistoryFn])

  // ===== 启动：读取服务器状态（纯读，服务器即事实源，无需回写） =====
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Vite 比 server 先就绪：页面先到会被拒连，重试直到 server 起来（最多 10s）
      let data: [SessionsData, Settings] | null = null
      for (let i = 0; i < 20; i++) {
        try {
          data = await Promise.all([fetchSessions(), fetchSettings()])
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      if (cancelled) return
      if (!data) {
        setStatus('无法连接服务器')
        return
      }
      setServerReady(true)
      serverReadyRef.current = true
      const [sessData, settingsData] = data
      setSettings(settingsData)
      settingsRef.current = settingsData
      setSessions(sessData.sessions || [])
      const cur = sessData.currentId ?? null
      setCurrentSessionId(cur)
      // 当前会话正在生成（如页面重开）：置忙并重新附加，重放事件恢复实时视图
      if (cur != null && (sessData.sessions || []).find((s) => s.id === cur)?.generating) {
        setBusy(true)
        busyRef.current = true
      }
      if (cur != null) void attachFnRef.current?.(cur)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ===== 流消费：NDJSON 事件 → 镜像 =====
  const consumeStream = useCallback(
    async (sessionId: number, res: Response) => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let errMsg = ''
      // 当轮 assistant 累积态（服务器预填为初值）
      const acc = new Map<string, { full: string; think: string; tcs: ToolCall[] }>()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          let m: StreamEvent
          try {
            m = JSON.parse(line)
          } catch {
            continue
          }
          if (m.h) {
            // 权威历史（追加 user / 重试回退后）：整体替换，官方 id 对齐
            setHistory(sessionId, m.h)
          } else if (m.a) {
            // 新 assistant 条目：按服务器指定位置插入占位；镜像已有（重放场景）则不重复插入
            const aid = m.a
            acc.set(aid, { full: '', think: '', tcs: [] })
            const pos = m.pos
            setGenId(aid) // 生成索引指示：本轮输出写往该条目，整轮常驻
            setHistoryFn(sessionId, (h) => {
              if (h.some((e) => e.id === aid)) return h
              const e: Entry = { id: aid, role: 'assistant', content: '' }
              const next = [...h]
              next.splice(pos ?? next.length, 0, e)
              return next
            })
          } else if (m.id && (m.c || m.r || m.t)) {
            const a = acc.get(m.id)
            if (!a) return
            if (m.c) {
              a.full += m.c
            }
            if (m.r) {
              a.think += m.r
            }
            if (m.t) {
              setExecutingId(m.id)
              const slot = a.tcs[m.t.i] ?? (a.tcs[m.t.i] = { id: '', name: '', arguments: '' })
              if (m.t.id) slot.id = m.t.id
              if (m.t.n) slot.name += m.t.n
              if (m.t.a) slot.arguments += m.t.a
              patchEntry(sessionId, m.id, { tool_calls: [...a.tcs] })
            }
            if (m.c || m.r) patchEntry(sessionId, m.id, { content: a.full, ...(a.think ? { reasoning: a.think } : {}) })
          } else if (m.m) {
            // 压缩气泡：pos=新建占位（摘要流复用 c 增量）；无 pos=定稿（ok 决定是否有效分割点）
            const mid = m.m.id
            if (m.m.pos !== undefined) {
              acc.set(mid, { full: '', think: '', tcs: [] })
              setGenId(mid)
              const pos = m.m.pos
              setHistoryFn(sessionId, (h) => {
                const e: Entry = { id: mid, role: 'summary', content: '' }
                const next = [...h]
                next.splice(pos ?? next.length, 0, e)
                return next
              })
            } else {
              patchEntry(sessionId, mid, m.m.ok ? {} : { summaryStatus: 'failed' })
            }
          } else if (m.x) {
            setExecutingId(null)
            setGenId(m.x) // 工具执行期间，生成索引位于工具结果条目
            const xid = m.x
            if (m.r !== undefined) {
              patchEntry(sessionId, xid, { content: m.r, ...(m.imgs ? { images: m.imgs } : {}) })
            } else {
              const pos = m.pos
              const tc = m.tc ?? ''
              setHistoryFn(sessionId, (h) => {
                const e: Entry = { id: xid, role: 'tool', tool_call_id: tc, content: '' }
                const next = [...h]
                next.splice(pos ?? next.length, 0, e)
                return next
              })
            }
          } else if (m.e) {
            errMsg = m.e
          } else if (m.d) {
            // 结束：权威历史替换镜像（服务器与浏览器严格一致）
            if (m.history) setHistory(sessionId, m.history)
            if (m.usage) setLastUsage(m.usage)
            if (m.contextTokens !== undefined) setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, contextTokens: m.contextTokens } : s)))
            setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, generating: false } : s)))
            if (m.title) setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, title: m.title! } : s)))
            setGenId(null)
            setBusy(false)
            busyRef.current = false
            if (errMsg) onErrorRef.current(errMsg.slice(0, 200))
            return
          }
        }
      }
    },
    [patchEntry, setHistory, setHistoryFn, setSessions],
  )

  // 重新附加：页面重开/切换会话时同步当前会话（进行中的生成重放事件重建视图；未在生成则一次性 d 收尾）
  const attachRef = useRef<AbortController | null>(null)
  const attachToSession = useCallback(
    async (sid: number) => {
      const controller = new AbortController()
      attachRef.current = controller
      try {
        const res = await fetch(`/api/sessions/${sid}/stream`, { signal: controller.signal })
        if (!res.ok || !res.body) return
        await consumeStream(sid, res)
      } catch {
        // 切换会话 abort / 服务器不可达：静默
      }
    },
    [consumeStream],
  )
  attachFnRef.current = attachToSession

  // 流式指令公共骨架：busy 管理 + 失败分类（停止=静默；其他=移除乐观条目+常驻通知）
  const startStream = useCallback(
    async (sessionId: number, url: string, body: unknown, tempId?: string) => {
      setBusy(true)
      busyRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
        }
        await consumeStream(sessionId, res)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // 停止：镜像已有累积内容，服务器已把同样的半截条目入库，两者一致
        } else {
          if (tempId) setHistoryFn(sessionId, (h) => h.filter((e) => e.id !== tempId))
          onErrorRef.current(((err as Error).message || '未知错误').slice(0, 200))
          // 流中断：镜像可能停在半途，从服务器重新水合恢复权威状态
          fetch('/api/sessions')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('resync failed'))))
            .then((d: { sessions?: Session[] }) => d.sessions && setSessions(d.sessions))
            .catch(() => {})
        }
      } finally {
        abortRef.current = null
        busyRef.current = false
        setBusy(false)
        setGenId(null)
        setExecutingId(null)
      }
    },
    [consumeStream, setHistoryFn],
  )

  // ===== 指令 =====
  const sendMessage = useCallback(
    (text: string, images: string[]) => {
      if (busyRef.current) return
      if (!text && !images.length) return
      const body = { content: text, ...(images.length ? { images } : {}) }
      const fire = (sid: number) => {
        // 乐观镜像：user 条目立即可见；官方 id 由服务器 h 事件对齐
        const tempId = `tmp-${Date.now()}`
        const user: Entry = { id: tempId, role: 'user', content: text }
        if (images.length) user.images = images
        setHistoryFn(sid, (h) => [...h, user])
        void startStream(sid, `/api/sessions/${sid}/messages`, body, tempId)
      }
      const cur = currentSessionIdRef.current
      if (cur != null) {
        fire(cur)
        return
      }
      // 无会话（最后一个被删除）：自动创建新会话后发送；创建失败给可见提示
      busyRef.current = true
      setBusy(true)
      fetch('/api/sessions', { method: 'POST' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ session, currentId: cid }: { session: Session; currentId: number }) => {
          setSessions((x) => [session, ...x])
          setCurrentSessionId(cid)
          fire(cid)
        })
        .catch(() => {
          busyRef.current = false
          setBusy(false)
          setStatus('无法连接服务器，不能创建会话')
        })
    },
    [setHistoryFn, setSessions, setCurrentSessionId, startStream, setStatus],
  )

  // 重试：服务器执行回退 + 重生成，镜像随 h/a 事件更新
  const retryEntry = useCallback(
    (id: string) => {
      if (busyRef.current) return
      const cur = currentSessionIdRef.current
      if (cur == null) return
      void startStream(cur, `/api/sessions/${cur}/messages/${id}/retry`, {})
    },
    [startStream],
  )

  // 停止：显式通知服务器中止（生成与连接解耦，断开前端不再停止生成）
  const stop = useCallback(() => {
    const cur = currentSessionIdRef.current
    if (cur == null) return
    fetch(`/api/sessions/${cur}/stop`, { method: 'POST' }).catch(() => {})
  }, [])

  const editEntry = useCallback(
    (id: string, patch: Partial<Entry>) => {
      const cur = currentSessionIdRef.current
      if (cur == null) return
      fetch(`/api/sessions/${cur}/messages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ entry, contextTokens }: { entry: Entry; contextTokens?: number }) => {
          patchEntry(cur, id, entry)
          if (contextTokens !== undefined) setSessions((x) => x.map((s) => (s.id === cur ? { ...s, contextTokens } : s)))
        })
        .catch(() => setStatus('保存失败（服务器不可达？）'))
    },
    [patchEntry],
  )

  const deleteEntries = useCallback(
    (ids: string[]) => {
      const cur = currentSessionIdRef.current
      if (cur == null || !ids.length) return
      fetch(`/api/sessions/${cur}/messages`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ history, contextTokens }: { history: Entry[]; contextTokens?: number }) => {
          setHistory(cur, history)
          if (contextTokens !== undefined) setSessions((x) => x.map((s) => (s.id === cur ? { ...s, contextTokens } : s)))
        })
        .catch(() => setStatus('保存失败（服务器不可达？）'))
    },
    [setHistory],
  )

  const deleteEntry = useCallback((id: string) => deleteEntries([id]), [deleteEntries])

  const newSession = useCallback(() => {
    if (busyRef.current) return
    fetch('/api/sessions', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(({ session, currentId: cid }: { session: Session; currentId: number }) => {
        setSessions((x) => [session, ...x])
        setCurrentSessionId(cid)
      })
      .catch(() => setStatus('保存失败（服务器不可达？）'))
  }, [])

  const deleteSession = useCallback(
    (id?: number) => {
      if (busyRef.current) return
      const target = id ?? currentSessionIdRef.current
      if (target == null) return
      fetch(`/api/sessions/${target}`, { method: 'DELETE' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ sessions: all, currentId: cid }: { sessions: Session[]; currentId: number | null }) => {
          setSessions(all)
          setCurrentSessionId(cid)
        })
        .catch(() => setStatus('保存失败（服务器不可达？）'))
    },
    [],
  )

  const renameSession = useCallback(
    (id: number, title: string) => {
      fetch(`/api/sessions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ session }: { session: Session }) => {
          setSessions((x) => x.map((s) => (s.id === id ? { ...s, title: session.title } : s)))
        })
        .catch(() => setStatus('重命名失败（服务器不可达？）'))
    },
    [setStatus],
  )

  const switchSession = useCallback(
    (id: number) => {
      if (busyRef.current || id === currentSessionIdRef.current) return
      attachRef.current?.abort() // 断开旧会话的附加（服务器生成不受影响）
      setCurrentSessionId(id) // 镜像立即切换
      if (sessionsRef.current.find((s) => s.id === id)?.generating) {
        setBusy(true)
        busyRef.current = true
      }
      void attachToSession(id) // 目标会话在生成则重放同步
      fetch(`/api/sessions/${id}/switch`, { method: 'POST' }).catch(() => {}) // 服务器记录 last-active
    },
    [attachToSession],
  )

  const saveSettings = useCallback(async (next: Settings): Promise<boolean> => {
    try {
      await putSettings(next)
      settingsRef.current = next
      setSettings(next)
      return true
    } catch {
      return false
    }
  }, [])

  return {
    sessions,
    currentSessionId,
    switchSession,
    newSession,
    deleteSession,
    renameSession,
    settings,
    saveSettings,
    busy,
    status,
    setStatus,
    serverReady,
    history: sessions.find((s) => s.id === currentSessionId)?.history ?? [],
    sendMessage,
    stop,
    editEntry,
    deleteEntry,
    deleteEntries,
    executingId,
    lastUsage,
    retryEntry,
    genId,
  }
}
