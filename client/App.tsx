import { useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from '@/components/Composer'
import { Header } from '@/components/Header'
import { MessageList } from '@/components/MessageList'
import { NotificationStack, type Notification } from '@/components/NotificationStack'
import { McpDialog } from '@/components/McpDialog'
import { MemoryDialog } from '@/components/MemoryDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { Sidebar } from '@/components/Sidebar'
import { useChat } from '@/hooks/useChat'
import { fileToDataURL } from '@/lib/images'
import { fetchMcp, fetchMemories, putMemories } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { McpServerConfig, McpServerStatus } from '@/lib/types'

export default function App() {
  const [effort, setEffort] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpEditing, setMcpEditing] = useState<McpServerConfig | null>(null)
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  const [memoriesOpen, setMemoriesOpen] = useState(false)
  const [memories, setMemories] = useState<string[]>([])
  const [memoryEditIndex, setMemoryEditIndex] = useState<number | null>(null)
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [scrollKey, setScrollKey] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768)
  // 通知：右上角叠加；error 常驻，info/warning 5s 自动移除，均可手动关闭
  const [notifs, setNotifs] = useState<Notification[]>([])
  // 拉取 MCP 状态；有服务器在连接中则每秒轮询，直到全部就绪（ok/error）
  const refreshMcpStatuses = useCallback(() => {
    const poll = async () => {
      try {
        const d = await fetchMcp()
        setMcpStatuses(d.servers)
        if (d.servers.some((s) => s.status === 'connecting')) setTimeout(poll, 1000)
      } catch {
        // 服务器不可达，忽略
      }
    }
    void poll()
  }, [])
  useEffect(() => {
    void fetchMemories()
      .then((d) => setMemories(d.memories))
      .catch(() => setMemories([]))
  }, [])
  useEffect(() => {
    refreshMcpStatuses()
  }, [refreshMcpStatuses])
  const notifSeq = useRef(0)
  const notifTimers = useRef(new Map<number, number>())
  const dismissNotif = useCallback((id: number) => {
    const t = notifTimers.current.get(id)
    if (t) {
      clearTimeout(t)
      notifTimers.current.delete(id)
    }
    setNotifs((x) => x.filter((n) => n.id !== id))
  }, [])
  const pushNotif = useCallback(
    (n: Omit<Notification, 'id'>) => {
      notifSeq.current += 1
      const id = notifSeq.current
      setNotifs((x) => [...x, { ...n, id }])
      if (n.variant !== 'error') {
        notifTimers.current.set(id, window.setTimeout(() => dismissNotif(id), 5000))
      }
    },
    [dismissNotif],
  )
  const memorySave = (text: string) => {
    const list = memories.slice()
    if (memoryEditIndex == null) list.push(text)
    else list[memoryEditIndex] = text
    void putMemories(list)
      .then((d) => setMemories(d.memories))
      .catch(() => pushNotif({ title: '记忆', description: '保存失败（服务器不可达？）', variant: 'error' }))
    setMemoriesOpen(false)
  }
  const memoryDelete = () => {
    if (memoryEditIndex == null) return
    const list = memories.slice()
    list.splice(memoryEditIndex, 1)
    void putMemories(list)
      .then((d) => setMemories(d.memories))
      .catch(() => pushNotif({ title: '记忆', description: '删除失败（服务器不可达？）', variant: 'error' }))
    setMemoriesOpen(false)
  }
  useEffect(() => {
    const timers = notifTimers.current
    return () => timers.forEach((t) => clearTimeout(t))
  }, [])
  const chat = useChat(effort, (msg) => pushNotif({ title: '请求失败', description: msg, variant: 'error' }))

  // TTS 朗读：单实例，点按钮合成+播放，再点停止；切换会话自动停止
  const [ttsId, setTtsId] = useState<string | null>(null)
  const [ttsLoadingId, setTtsLoadingId] = useState<string | null>(null)
  const ttsRef = useRef<{ audio: HTMLAudioElement; cancel: AbortController; url: string } | null>(null)
  const stopTts = useCallback(() => {
    const t = ttsRef.current
    if (t) {
      t.cancel.abort()
      t.audio.pause()
      URL.revokeObjectURL(t.url)
      ttsRef.current = null
    }
    setTtsId(null)
    setTtsLoadingId(null)
  }, [])
  const toggleTts = useCallback(
    async (entryId: string, text: string) => {
      if (ttsId === entryId) {
        stopTts()
        return
      }
      stopTts()
      setTtsLoadingId(entryId)
      const cancel = new AbortController()
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: cancel.signal,
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null
          pushNotif({ title: '朗读失败', description: j?.error ?? `HTTP ${res.status}`, variant: 'error' })
          setTtsLoadingId(null)
          return
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.onended = () => {
          if (ttsRef.current?.audio === audio) stopTts()
        }
        ttsRef.current = { audio, cancel, url }
        setTtsId(entryId)
        await audio.play()
        setTtsLoadingId(null)
      } catch (e) {
        if (!cancel.signal.aborted) {
          pushNotif({ title: '朗读失败', description: e instanceof Error ? e.message : String(e), variant: 'error' })
        }
        stopTts()
      }
    },
    [ttsId, stopTts, pushNotif],
  )
  useEffect(() => {
    stopTts()
  }, [chat.currentSessionId, stopTts])

  // effort 跟随服务器设置：启动时恢复，变更时持久化
  useEffect(() => {
    setEffort(chat.settings.effort)
  }, [chat.settings])

  const changeEffort = (v: string) => {
    setEffort(v)
    void chat.saveSettings({ ...chat.settings, effort: v })
  }

  const addImages = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      fileToDataURL(f).then((url) => setPendingImages((prev) => [...prev, url]))
    }
  }

  const send = (text: string) => {
    chat.sendMessage(text, pendingImages)
    setPendingImages([])
    setScrollKey((k) => k + 1)
  }

  return (
    <div
      className={cn('h-dvh flex', dragOver && 'outline-dashed outline-2 -outline-offset-8 outline-primary')}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        addImages(e.dataTransfer.files)
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.items)
          .map((i) => i.getAsFile())
          .filter((f): f is File => f != null)
        if (files.length) addImages(files)
      }}
    >
      <Sidebar
        open={sidebarOpen}
        sessions={chat.sessions}
        currentSessionId={chat.currentSessionId}
        onSwitch={(id) => {
          chat.switchSession(id)
          if (window.innerWidth < 768) setSidebarOpen(false)
        }}
        onNew={chat.newSession}
        onDelete={chat.deleteSession}
        onRename={chat.renameSession}
        memories={memories}
        onMemories={(index) => {
          setMemoryEditIndex(index ?? null)
          setMemoriesOpen(true)
          if (window.innerWidth < 768) setSidebarOpen(false)
        }}
        onMcp={() => {
          setMcpEditing(null)
          setMcpOpen(true)
          if (window.innerWidth < 768) setSidebarOpen(false)
        }}
        mcpServers={chat.settings.mcp}
        mcpStatuses={mcpStatuses}
        pwshEnabled={chat.settings.pwsh}
        onPwshToggle={(v) => {
          void chat.saveSettings({ ...chat.settings, pwsh: v })
        }}
        onEditMcp={(c) => {
          setMcpEditing(c)
          setMcpOpen(true)
          if (window.innerWidth < 768) setSidebarOpen(false)
        }}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          effort={effort}
          status={chat.status}
          lastPromptTokens={chat.sessions.find((s) => s.id === chat.currentSessionId)?.lastPromptTokens}
          lastCompletionTokens={chat.sessions.find((s) => s.id === chat.currentSessionId)?.lastCompletionTokens}
          maxContext={chat.settings.maxContext}
          busy={chat.busy}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onEffortChange={changeEffort}
          onOpenSettings={() => setSettingsOpen(true)}
          onCompact={chat.compactContext}
          onRefreshUsage={() => chat.refreshUsage()}
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageList
            key={chat.currentSessionId}
            history={chat.history}
            busy={chat.busy}
            genId={chat.genId}
            executingId={chat.executingId}
            resetKey={scrollKey}
            onEdit={chat.editEntry}
            onDelete={chat.deleteEntry}
            onBulkDelete={chat.deleteEntries}
            onRetry={chat.retryEntry}
            ttsActiveId={ttsId}
            ttsLoadingId={ttsLoadingId}
            onTts={toggleTts}
          />
          {/* 底部淡出：白色渐变条只覆盖输入框默认高度（88px），不影响其上方的内容 */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-4 z-[5] h-22 bg-gradient-to-t from-background to-transparent" />
          {/* 输入框浮层：只有输入框本体不透明，两侧露出后面的消息内容 */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
            <div className="px-4 pb-4">
              <div className="pointer-events-auto mx-auto w-full max-w-3xl">
                <Composer
                  busy={chat.busy}
                  images={pendingImages}
                  onSend={send}
                  onStop={chat.stop}
                  onAttach={addImages}
                  onRemoveImage={(i) => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={chat.settings}
        onSave={chat.saveSettings}
      />
      <McpDialog
        open={mcpOpen}
        onOpenChange={setMcpOpen}
        editing={mcpEditing}
        settings={chat.settings}
        onSave={chat.saveSettings}
        onSaved={() => {
          refreshMcpStatuses()
          pushNotif({ title: 'MCP', description: '配置已保存', variant: 'info' })
        }}
      />
      <MemoryDialog
        open={memoriesOpen}
        onOpenChange={setMemoriesOpen}
        mode={memoryEditIndex == null ? 'create' : 'edit'}
        initialText={memoryEditIndex == null ? '' : (memories[memoryEditIndex] ?? '')}
        onSave={memorySave}
        onDelete={memoryEditIndex == null ? undefined : memoryDelete}
      />
      <NotificationStack items={notifs} onDismiss={dismissNotif} />
    </div>
  )
}