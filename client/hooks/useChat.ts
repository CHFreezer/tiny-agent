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
  lastPromptTokens?: number
  lastCompletionTokens?: number
}

// 全局同步事件（WebSocket /api/events）：服务器把会话层变更推给所有设备；
// 内容级增量仍走会话流（GET /api/sessions/:id/stream），本设备据此在需要时附加该流重放内容
type SessionMeta = Omit<Session, 'history'>

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

interface SyncEvent {
  list?: SessionMeta[] // 会话列表元数据（连接时的初始快照 + 新建/删除/重命名）
  currentId?: number | null
  sid?: number
  gen?: boolean // 某会话开始/结束生成
  err?: string // 生成失败原因（随 gen:false 下发，没在看该会话的设备据此提示）
  stopped?: boolean // 该轮是被显式停止的（与"正常完成"区分）
  title?: string
  lastPromptTokens?: number
  lastCompletionTokens?: number
  entry?: Entry // 条目被其他设备编辑
  history?: Entry[] // 条目被其他设备删除
}

// 单会话的视图态（生成索引气泡 / 工具执行中 / 压缩中）——按会话存，不再是一个全局值
interface ViewState {
  genId: string | null
  executingId: string | null
  compacting: boolean
}
const EMPTY_VIEW: ViewState = { genId: null, executingId: null, compacting: false }

export interface ChatNotice {
  title: string
  description?: string
  variant: 'info' | 'warning' | 'error'
}

export function useChat(effort: string, onError: (message: string) => void, onNotify: (n: ChatNotice) => void) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState('')
  // 每个会话各自的「视图态」：生成索引气泡 / 工具执行中 / 压缩中。
  // 按会话隔离后，切走再切回、或同时跑多个会话，都不会互相串味。
  const [viewStates, setViewStates] = useState<Map<number, ViewState>>(new Map())
  const patchView = useCallback((sid: number, patch: Partial<ViewState>) => {
    setViewStates((m) => {
      const next = { ...(m.get(sid) ?? EMPTY_VIEW), ...patch }
      const empty = !next.genId && !next.executingId && !next.compacting
      if (empty) {
        if (!m.has(sid)) return m
        const c = new Map(m)
        c.delete(sid)
        return c
      }
      const c = new Map(m)
      c.set(sid, next)
      return c
    })
  }, [])

  const currentSessionIdRef = useRef(currentSessionId)
  currentSessionIdRef.current = currentSessionId
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const effortRef = useRef(effort)
  effortRef.current = effort
  // 本设备持有的会话流：genStreams=本设备发起的生成流（POST 响应），attachStreams=为同步视图附加的流（GET）。
  // 均按会话各一条；切换会话只动 attach，自己发起的生成流继续把增量写进它自己的镜像。
  const genStreams = useRef(new Map<number, AbortController>())
  const attachStreams = useRef(new Map<number, AbortController>())
  const hasStream = (sid: number) => genStreams.current.has(sid) || attachStreams.current.has(sid)
  const creatingRef = useRef(false) // 无会话时"先建会话再发送"的防重入
  // 本设备发起过生成的会话（用于避免"自己发起 → 已弹过错误 → WS 再弹一次"的重复通知）
  const ownGenSids = useRef(new Set<number>())
  const attachFnRef = useRef<((sid: number) => void) | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNotifyRef = useRef(onNotify)
  onNotifyRef.current = onNotify

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
          await sleep(500)
        }
      }
      if (cancelled) return
      if (!data) {
        setStatus('无法连接服务器')
        return
      }
      const [sessData, settingsData] = data
      setSettings(settingsData)
      settingsRef.current = settingsData
      setSessions(sessData.sessions || [])
      const cur = sessData.currentId ?? null
      setCurrentSessionId(cur)
      // 当前会话若正在生成（如页面重开），附加会话流即可：重放事件恢复实时视图；
      // 忙态不再单独存，直接由镜像里的 generating 派生
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
            // 新 assistant 条目：按服务器绝对 pos 插入（常规 pos=历史末尾；重试 pos=中间原位插入）；镜像已有（重放场景）则不重复插入
            const aid = m.a
            acc.set(aid, { full: '', think: '', tcs: [] })
            patchView(sessionId, { genId: aid }) // 生成索引指示：本轮输出写往该条目，整轮常驻
            setHistoryFn(sessionId, (h) => {
              if (h.some((e) => e.id === aid)) return h
              if (m.pos === undefined) return [...h, { id: aid, role: 'assistant', content: '' }]
              const next = [...h]
              next.splice(m.pos, 0, { id: aid, role: 'assistant', content: '' })
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
              patchView(sessionId, { executingId: m.id })
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
              const mpos = m.m.pos
              acc.set(mid, { full: '', think: '', tcs: [] })
              patchView(sessionId, { genId: mid, compacting: true })
              setHistoryFn(sessionId, (h) => {
                if (h.some((e) => e.id === mid)) return h
                const next = [...h]
                next.splice(mpos, 0, { id: mid, role: 'summary', content: '' })
                return next
              })
            } else {
              patchView(sessionId, { compacting: false })
              patchEntry(sessionId, mid, m.m.ok ? {} : { summaryStatus: 'failed' })
            }
          } else if (m.x) {
            patchView(sessionId, { executingId: null, genId: m.x }) // 工具执行期间，生成索引位于工具结果条目
            const xid = m.x
            if (m.r !== undefined) {
              patchEntry(sessionId, xid, { content: m.r, ...(m.imgs ? { images: m.imgs } : {}) })
            } else {
              const tc = m.tc ?? ''
              setHistoryFn(sessionId, (h) => {
                if (h.some((e) => e.id === xid)) return h
                if (m.pos === undefined) return [...h, { id: xid, role: 'tool', tool_call_id: tc, content: '' }]
                const next = [...h]
                next.splice(m.pos, 0, { id: xid, role: 'tool', tool_call_id: tc, content: '' })
                return next
              })
            }
          } else if (m.e) {
            errMsg = m.e
          } else if (m.d) {
            // 结束：权威历史替换镜像（服务器与浏览器严格一致）
            if (m.history) setHistory(sessionId, m.history)
            if (m.lastPromptTokens !== undefined) setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, lastPromptTokens: m.lastPromptTokens } : s)))
            if (m.lastCompletionTokens !== undefined) setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, lastCompletionTokens: m.lastCompletionTokens } : s)))
            setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, generating: false } : s)))
            if (m.title) setSessions((x) => x.map((s) => (s.id === sessionId ? { ...s, title: m.title! } : s)))
            patchView(sessionId, { genId: null, executingId: null, compacting: false })
            if (errMsg) onErrorRef.current(errMsg.slice(0, 200))
            return
          } else if (m.lastPromptTokens !== undefined || m.lastCompletionTokens !== undefined) {
            // 实时用量：主请求返回后服务器推送精确值（非结束事件）
            setSessions((x) =>
              x.map((s) =>
                s.id === sessionId
                  ? { ...s, ...(m.lastPromptTokens !== undefined ? { lastPromptTokens: m.lastPromptTokens } : {}), ...(m.lastCompletionTokens !== undefined ? { lastCompletionTokens: m.lastCompletionTokens } : {}) }
                  : s,
              ),
            )
          }
        }
      }
    },
    [patchEntry, patchView, setHistory, setHistoryFn, setSessions],
  )

  // 重新附加：页面重开/切换会话时同步该会话（生成中→重放并续流；空闲→一次性 d 回灌权威历史）。
  // 每个会话最多一条附加流；同一会话已有流（自己发起的生成流或已附加）时不重复附加。
  const attachToSession = useCallback(
    async (sid: number) => {
      if (hasStream(sid)) return
      const controller = new AbortController()
      attachStreams.current.set(sid, controller)
      try {
        const res = await fetch(`/api/sessions/${sid}/stream`, { signal: controller.signal })
        if (!res.ok || !res.body) return
        await consumeStream(sid, res)
      } catch {
        // 切换会话 abort / 服务器不可达：静默
      } finally {
        if (attachStreams.current.get(sid) === controller) attachStreams.current.delete(sid)
      }
    },
    [consumeStream],
  )
  attachFnRef.current = attachToSession

  // ===== 跨设备同步：WebSocket 通道（/api/events）=====
  // 会话层变更（列表/生成态/条目编辑）→ 直接落到镜像；被查看的会话生成中 → 附加会话流重放内容增量
  const applySync = useCallback(
    (m: SyncEvent) => {
      const cur = currentSessionIdRef.current
      if (m.list) {
        const meta = m.list
        const known = new Set(meta.map((n) => n.id))
        // 合并元数据（保留本地已加载的历史：快照与变更通知都不带 history）
        setSessions((x) => {
          const prev = new Map(x.map((s) => [s.id, s]))
          return meta.map((n) => {
            const old = prev.get(n.id)
            return old ? { ...old, ...n } : { ...n, history: [] }
          })
        })
        // 被删掉的会话不再需要它的视图态与附加流
        setViewStates((m0) => {
          if (!m0.size) return m0
          const keep = new Map([...m0].filter(([sid]) => known.has(sid)))
          return keep.size === m0.size ? m0 : keep
        })
        for (const [sid, ctl] of [...attachStreams.current]) if (!known.has(sid)) {
          ctl.abort()
          attachStreams.current.delete(sid)
        }
        // 本设备的当前会话已被其他设备删除：跟随服务器 currentId 切走（其余情况不抢焦点）
        if (cur != null && m.currentId !== undefined && !known.has(cur)) {
          setCurrentSessionId(m.currentId)
          if (m.currentId != null) void attachToSession(m.currentId)
          return
        }
        // 连接/断线重连后的快照：重新附加本会话流——生成中→重放增量续流；空闲→一次性 d 回灌权威历史
        // （重连期间漏收的 {sid,entry}/{sid,history} 由此补齐；本设备正持有该会话流时跳过）
        if (cur != null) void attachToSession(cur)
        return
      }
      if (m.sid === undefined) return
      if (m.gen !== undefined) {
        setSessions((x) =>
          x.map((s) =>
            s.id === m.sid
              ? {
                  ...s,
                  generating: m.gen,
                  ...(m.title !== undefined ? { title: m.title } : {}),
                  ...(m.lastPromptTokens !== undefined ? { lastPromptTokens: m.lastPromptTokens } : {}),
                  ...(m.lastCompletionTokens !== undefined ? { lastCompletionTokens: m.lastCompletionTokens } : {}),
                }
              : s,
          ),
        )
        if (m.gen) {
          // 这个会话开始生成：正在看它就附加会话流（重放缓冲事件 → 内容实时同步）；没在看则只更新侧栏状态
          if (m.sid === cur) void attachToSession(m.sid)
          return
        }
        // 结束：清掉该会话的视图态；没在看它 → 弹通知
        // （自己发起的生成，失败已经由发起时的通知报过，这里不重复弹）
        patchView(m.sid, { genId: null, executingId: null, compacting: false })
        const own = ownGenSids.current.delete(m.sid)
        const name = `会话「${m.title ?? m.sid}」`
        if (m.err) {
          if (m.sid !== cur && !own) onNotifyRef.current({ title: `${name}生成失败`, description: m.err.slice(0, 200), variant: 'error' })
        } else if (m.sid !== cur) {
          onNotifyRef.current({ title: m.stopped ? `${name}已停止` : `${name}已完成`, variant: 'info' })
        }
      } else if (m.entry) {
        patchEntry(m.sid, m.entry.id, m.entry)
      } else if (m.history) {
        setHistory(m.sid, m.history)
      }
    },
    [attachToSession, patchEntry, patchView, setHistory, setSessions],
  )

  // WS 常驻 + 断线重连（1s 固定退避）：服务器重启、移动端休眠回前台都能自动接上；
  // 存活由服务器 ws 协议级 ping/pong 判定，应用层不发心跳消息
  useEffect(() => {
    let alive = true
    let ws: WebSocket | null = null
    let timer: number | undefined
    const connect = () => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`
      ws = new WebSocket(url)
      ws.onmessage = (e) => {
        try {
          applySync(JSON.parse(String(e.data)) as SyncEvent)
        } catch {
          // 非 JSON 帧：忽略
        }
      }
      // 握手失败/连接断开都会触发 close（error 之后必跟 close），统一在这里退避重连
      ws.onclose = () => {
        if (!alive) return
        clearTimeout(timer)
        timer = window.setTimeout(connect, 1000)
      }
    }
    connect()
    return () => {
      alive = false
      clearTimeout(timer)
      ws?.close()
    }
  }, [applySync])


  // 流式指令公共骨架：按会话登记流 + 失败分类（停止=静默；其他=移除乐观条目+常驻通知+重新水合该会话）
  const startStream = useCallback(
    async (sessionId: number, url: string, body: unknown, tempId?: string) => {
      const controller = new AbortController()
      genStreams.current.set(sessionId, controller)
      ownGenSids.current.add(sessionId)
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
          // 流中断：该会话镜像可能停在半途 → 立刻重新附加，回灌权威历史（生成仍在跑则续流）
          if (genStreams.current.get(sessionId) === controller) genStreams.current.delete(sessionId)
          void attachToSession(sessionId)
        }
      } finally {
        if (genStreams.current.get(sessionId) === controller) genStreams.current.delete(sessionId)
        patchView(sessionId, { genId: null, executingId: null })
      }
    },
    [attachToSession, consumeStream, patchView, setHistoryFn],
  )

  // ===== 指令 =====
  const sendMessage = useCallback(
    (text: string, images: string[]) => {
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
        // 目标会话正在生成：服务器会 409，这里提前拦一句（同会话排队未实现，只能先停止）
        if (sessionsRef.current.find((s) => s.id === cur)?.generating) {
          setStatus('该会话正在生成中：先停止，或切到别的会话继续')
          return
        }
        fire(cur)
        return
      }
      // 无会话（最后一个被删除）：自动创建新会话后发送；创建失败给可见提示
      if (creatingRef.current) return
      creatingRef.current = true
      fetch('/api/sessions', { method: 'POST' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(({ session, currentId: cid }: { session: Session; currentId: number }) => {
          // 服务器的 list 广播先于本响应到达：按 id 去重，避免同一个会话被插入两次
          setSessions((x) => [session, ...x.filter((s) => s.id !== session.id)])
          setCurrentSessionId(cid)
          fire(cid)
        })
        .catch(() => {
          setStatus('无法连接服务器，不能创建会话')
        })
        .finally(() => {
          creatingRef.current = false
        })
    },
    [setHistoryFn, setSessions, setCurrentSessionId, startStream, setStatus],
  )

  // 重试：服务器执行回退 + 重生成，镜像随 h/a 事件更新
  const retryEntry = useCallback(
    (id: string) => {
      const cur = currentSessionIdRef.current
      if (cur == null) return
      void startStream(cur, `/api/sessions/${cur}/messages/${id}/retry`, {})
    },
    [startStream],
  )

  // 手动压缩上下文：服务器生成 summary 条目，m 事件让气泡实时出现在聊天里
  const compactContext = useCallback(() => {
    const cur = currentSessionIdRef.current
    if (cur == null) return
    void startStream(cur, `/api/sessions/${cur}/compact`, {})
  }, [startStream])

  // 查询精确用量：上游 1-token 请求实测 prompt_tokens（旧会话无精确值时按需获取）
  const refreshUsage = useCallback(async (): Promise<boolean> => {
    const cur = currentSessionIdRef.current
    if (cur == null) return false
    try {
      const r = await fetch(`/api/sessions/${cur}/usage`)
      const d = (await r.json().catch(() => null)) as { promptTokens?: number; completionTokens?: number } | null
      if (!d || d.promptTokens == null || d.promptTokens <= 0) return false
      setSessions((x) => x.map((s) => (s.id === cur ? { ...s, lastPromptTokens: d.promptTokens, lastCompletionTokens: d.completionTokens ?? 0 } : s)))
      return true
    } catch {
      // 服务器不可达：忽略
      return false
    }
  }, [setSessions])

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
        .then(({ entry }: { entry: Entry }) => {
          patchEntry(cur, id, entry)
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
        .then(({ history }: { history: Entry[] }) => {
          setHistory(cur, history)
        })
        .catch(() => setStatus('保存失败（服务器不可达？）'))
    },
    [setHistory],
  )

  const deleteEntry = useCallback((id: string) => deleteEntries([id]), [deleteEntries])

  const newSession = useCallback(() => {
    fetch('/api/sessions', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(({ session, currentId: cid }: { session: Session; currentId: number }) => {
        // 服务器的 list 广播先于本响应到达：按 id 去重，避免同一个会话被插入两次
        setSessions((x) => [session, ...x.filter((s) => s.id !== session.id)])
        setCurrentSessionId(cid)
      })
      .catch(() => setStatus('保存失败（服务器不可达？）'))
  }, [])

  const deleteSession = useCallback(
    (id?: number) => {
      const target = id ?? currentSessionIdRef.current
      if (target == null) return
      if (sessionsRef.current.find((s) => s.id === target)?.generating) {
        setStatus('该会话正在生成中：先停止再删除')
        return
      }
      attachStreams.current.get(target)?.abort()
      attachStreams.current.delete(target)
      patchView(target, { genId: null, executingId: null, compacting: false })
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
      const prev = currentSessionIdRef.current
      if (id === prev) return
      // 只断"离开的会话"的附加流（服务器生成不受影响；回来时会重新附加并重放）；
      // 本设备发起的生成流不断——它继续把增量写进它自己那个会话的镜像
      if (prev != null) {
        attachStreams.current.get(prev)?.abort()
        attachStreams.current.delete(prev)
      }
      setCurrentSessionId(id) // 镜像立即切换
      void attachToSession(id) // 目标会话：生成中→续流；空闲→一次性 d 回灌
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

  // 视图态：只暴露"当前会话"那一份（App/MessageList 的 props 形状不变）
  const view = viewStates.get(currentSessionId ?? -1) ?? EMPTY_VIEW

  return {
    sessions,
    currentSessionId,
    switchSession,
    newSession,
    deleteSession,
    renameSession,
    settings,
    saveSettings,
    busy: !!sessions.find((s) => s.id === currentSessionId)?.generating,
    compacting: view.compacting,
    status,
    setStatus,
    history: sessions.find((s) => s.id === currentSessionId)?.history ?? [],
    sendMessage,
    stop,
    editEntry,
    deleteEntry,
    deleteEntries,
    executingId: view.executingId,
    retryEntry,
    compactContext,
    refreshUsage,
    genId: view.genId,
  }
}
