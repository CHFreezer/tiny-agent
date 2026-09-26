import { Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import type { McpServerConfig, McpServerStatus, Session } from '@/lib/types'

export function Sidebar({
  open,
  sessions,
  currentSessionId,
  onSwitch,
  onNew,
  onDelete,
  onMcp,
  onClose,
  mcpServers,
  mcpStatuses,
  onEditMcp,
  onRename,
  memories,
  onMemories,
  pwshEnabled,
  onPwshToggle,
}: {
  open: boolean
  sessions: Session[]
  currentSessionId: number | null
  onSwitch: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
  onMcp: () => void
  onClose: () => void
  mcpServers: McpServerConfig[]
  mcpStatuses: McpServerStatus[]
  onEditMcp: (c: McpServerConfig) => void
  onRename: (id: number, title: string) => void
  memories: string[]
  onMemories: (index?: number) => void
  pwshEnabled: boolean
  onPwshToggle: (v: boolean) => void
}) {
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [renameId, setRenameId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameBusy = useRef(false)
  const commitRename = (id: number, original: string) => {
    if (renameBusy.current) return
    renameBusy.current = true
    setRenameId(null)
    const t = renameText.trim()
    if (t && t !== original) onRename(id, t)
  }
  return (
    <>
      {/* 移动端遮罩 */}
      {open && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-background transition-transform md:static md:z-auto md:transition-none',
          open ? 'translate-x-0' : '-translate-x-full md:hidden',
        )}
      >
        <div className="p-2">
          <Button size="sm" variant="outline" className="w-full" onClick={onNew}>
            新建
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="flex flex-col gap-0.5">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={cn(
                  'group flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm',
                  s.id === currentSessionId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
                onClick={() => onSwitch(s.id)}
              >
                {renameId === s.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(s.id, s.title)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s.id, s.title)
                      if (e.key === 'Escape') {
                        renameBusy.current = true
                        setRenameId(null)
                      }
                    }}
                    className="h-6 w-full rounded border border-border bg-background px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                ) : (
                  <>
                    <span className="flex-1 truncate">{s.title}</span>
                    <button
                      type="button"
                      title="重命名"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover-reveal hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        renameBusy.current = false
                        setRenameText(s.title)
                        setRenameId(s.id)
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover-reveal hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteId(s.id)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="border-t border-border p-2">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs font-medium text-muted-foreground">记忆</span>
            <button
              type="button"
              title="新建记忆"
              onClick={() => onMemories()}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {memories.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">无（点 + 添加）</div>}
            {memories.map((m, i) => (
              <button
                key={i}
                type="button"
                title={m}
                onClick={() => onMemories(i)}
                className="truncate rounded-lg px-2.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="border-t border-border p-2">
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs font-medium text-muted-foreground">MCP 工具</span>
            <button
              type="button"
              title="添加 MCP 服务器"
              onClick={onMcp}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
            {mcpServers.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">未配置，点上方 MCP 添加</div>
            )}
            {mcpServers.map((c) => {
              const st = c.enabled ? mcpStatuses.find((s) => s.name === c.name.trim()) : undefined
              return (
                <button
                  key={c.name}
                  type="button"
                  title={st?.status === 'error' ? st.error : `编辑 ${c.name}`}
                  onClick={() => onEditMcp(c)}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      !c.enabled
                        ? 'bg-muted-foreground/30'
                        : st?.status === 'ok'
                          ? 'bg-emerald-500'
                          : st?.status === 'connecting'
                            ? 'bg-amber-500'
                            : st
                              ? 'bg-destructive'
                              : 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {!c.enabled
                      ? '已禁用'
                      : st?.status === 'ok'
                        ? `${st.tools.length} 工具`
                        : st?.status === 'connecting'
                          ? '连接中…'
                          : st
                            ? '失败'
                            : '未连接'}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="mt-1 flex items-center justify-between rounded-lg px-2.5 py-1.5">
            <span className="flex items-center gap-[5px] text-sm" title="pwsh 工具：允许模型在本地执行 PowerShell 命令">
              <SquareTerminal className="-ml-[3px] size-3.5 shrink-0" />
              pwsh
            </span>
            <Switch checked={pwshEnabled} onCheckedChange={onPwshToggle} />
          </div>
        </div>
      </aside>
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteId(null)
        }}
        title="删除该会话？"
        description="会话内容将不可恢复"
        onConfirm={() => {
          if (deleteId !== null) onDelete(deleteId)
          setDeleteId(null)
        }}
      />
    </>
  )
}