import { Check, Copy, ListChecks, Loader2, MoreHorizontal, Pencil, RotateCw, Trash2, Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EntryContent, markdownToPlain } from '@/components/EntryContent'
import { EditForm } from '@/components/EditForm'
import { cn } from '@/lib/utils'
import type { Entry } from '@/lib/types'

// 相对时间：<1分钟→秒，<1小时→分钟，<1天→时/分/秒，≥1天→年月日时分秒
function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) {
    const h = Math.floor(diff / 3_600_000)
    const m = Math.floor((diff % 3_600_000) / 60_000)
    const s = Math.floor((diff % 60_000) / 1000)
    return `${h}小时${m}分钟${s}秒前`
  }
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function MessageRow({
  entry,
  generating,
  executing,
  busy,
  onEdit,
  onDelete,
  onRetry,
  ttsActive = false,
  ttsLoading = false,
  selected = false,
  onToggleSelect,
  selectMode = false,
  onEnterSelectMode,
  onTts,
}: {
  entry: Entry
  generating?: boolean
  executing?: boolean
  busy: boolean
  onEdit: (patch: Partial<Entry>) => void
  onDelete: () => void
  onRetry: () => void
  ttsActive?: boolean
  ttsLoading?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  selectMode?: boolean
  onEnterSelectMode?: (id: string) => void
  onTts?: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRetry, setConfirmRetry] = useState(false)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // 编辑模式统一白底卡片样式（黑/灰气泡内的编辑表单太突兀）
  // max-w 必须放在各角色分支里：基类与覆盖类同元素时，Tailwind v4 中任意值 max-w-[85%] 优先级高于内置 max-w-full，覆盖会失效
  const bubbleClass = editing
    ? 'border border-border bg-card text-foreground max-w-[85%]'
    : entry.role === 'user'
      ? 'bg-primary text-primary-foreground max-w-[85%]'
      : entry.role === 'system'
        ? 'border border-dashed border-border bg-muted/40 text-muted-foreground text-[13px] max-w-[85%]'
        : entry.role === 'tool'
          ? 'border border-border bg-card text-foreground max-w-[85%] text-[13px]'
          : entry.role === 'summary'
            ? 'border-0 bg-transparent shadow-none px-0 py-1 max-w-full'
    : 'border border-border bg-card text-foreground max-w-[85%]'
  // 完全空的条目（无正文/思考/工具调用）不渲染气泡壳
  const isEmpty = !entry.content && !entry.reasoning && !entry.tool_calls?.length

  return (
    <div className={cn('group flex flex-col gap-1', entry.role === 'user' ? 'items-end' : 'items-stretch')}>
      {!isEmpty && (
      <div
        className={cn(
          'relative rounded-xl px-3.5 py-2.5 text-sm leading-relaxed break-words shadow-sm',
          bubbleClass,
          selected && 'ring-2 ring-primary/60',
          selectMode && 'cursor-pointer',
        )}
        onClick={selectMode ? onToggleSelect : undefined}
      >
        {selectMode && (
          <button
            type="button"
            title={selected ? '取消选择' : '选择'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect?.()
            }}
            className={cn(
              'absolute -top-2 z-10 flex size-5 items-center justify-center rounded-full border shadow-sm transition-colors',
              entry.role === 'user' ? '-right-2' : '-left-2',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-transparent hover:bg-accent',
            )}
          >
            <Check className="size-3" />
          </button>
        )}
        {editing ? (
          <EditForm
            entry={entry}
            onSave={(patch) => {
              onEdit(patch)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <EntryContent entry={entry} executing={executing} selectMode={selectMode} />
        )}
      </div>
      )}
      {generating && (
        // 生成索引指示：放在当前生成 item 的下方
        <div className="flex items-center gap-1 self-start pl-1">
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0.3s]" />
        </div>
      )}
      {!editing && (
        <div className={cn('flex items-center gap-1', !selected && 'hover-reveal')}>
          {entry.role === 'user' && entry.ts && (
            <span className="px-1 text-[10px] leading-tight text-muted-foreground/70">{relTime(entry.ts)}</span>
          )}
          <Button size="icon-xs" variant="ghost" title="编辑" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          {entry.role !== 'system' && (
            <Button size="icon-xs" variant="ghost" title="删除" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </Button>
          )}
          {entry.role !== 'system' && entry.role !== 'tool' && (
            <Button size="icon-xs" variant="ghost" title="重试" disabled={busy} onClick={() => setConfirmRetry(true)}>
              <RotateCw />
            </Button>
          )}
          {entry.role !== 'system' && entry.content && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="复制"
              onClick={async () => {
                const text = entry.content ?? ''
                try {
                  await navigator.clipboard.writeText(text)
                } catch {
                  const ta = document.createElement('textarea')
                  ta.value = text
                  ta.style.position = 'fixed'
                  ta.style.opacity = '0'
                  document.body.appendChild(ta)
                  ta.select()
                  document.execCommand('copy')
                  ta.remove()
                }
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          )}
          {entry.role !== 'system' && (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger
                render={<Button size="icon-xs" variant="ghost" title="更多" />}
              >
                <MoreHorizontal />
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="min-w-28">
                {entry.role === 'assistant' && entry.content && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setMenuOpen(false)
                      onTts?.(markdownToPlain(entry.content ?? ''))
                    }}
                  >
                    {ttsLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : ttsActive ? (
                      <VolumeX className="size-4" />
                    ) : (
                      <Volume2 className="size-4" />
                    )}
                    {ttsLoading ? '合成中…' : ttsActive ? '停止朗读' : '朗读'}
                  </button>
                )}
                {onEnterSelectMode && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setMenuOpen(false)
                      onEnterSelectMode(entry.id)
                    }}
                  >
                    <ListChecks className="size-4" />
                    多选
                  </button>
                )}
              </PopoverContent>
            </Popover>
          )}
          {entry.role !== 'user' && entry.ts && (
            <span className="px-1 text-[10px] leading-tight text-muted-foreground/70">{relTime(entry.ts)}</span>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除该条目？"
        onConfirm={onDelete}
      />
      <ConfirmDialog
        open={confirmRetry}
        onOpenChange={setConfirmRetry}
        title="从此条目重试？"
        description="从该位置重新生成；首个输出到达后，其后的旧内容将被删除"
        confirmLabel="重试"
        onConfirm={onRetry}
      />
    </div>
  )
}