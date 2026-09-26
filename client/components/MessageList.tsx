import { useEffect, useRef, useState } from 'react'
import { ArrowDown, X } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { MessageRow } from '@/components/MessageRow'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Entry } from '@/lib/types'

export function MessageList({
  history,
  busy,
  genId,
  executingId,
  resetKey,
  onEdit,
  onDelete,
  onBulkDelete,
  onRetry,
  ttsActiveId,
  ttsLoadingId,
  onTts,
}: {
  history: Entry[]
  busy: boolean
  genId: string | null
  executingId: string | null
  resetKey: number
  onEdit: (id: string, patch: Partial<Entry>) => void
  onDelete: (id: string) => void
  onBulkDelete: (ids: string[]) => void
  onRetry: (id: string) => void
  ttsActiveId: string | null
  ttsLoadingId: string | null
  onTts: (id: string, text: string) => void
}) {
  const ref = useRef<VirtuosoHandle>(null)
  const [showJump, setShowJump] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [confirmBulk, setConfirmBulk] = useState(false)

  // 多选模式下选择清空（取消最后一条）→ 退出多选模式
  useEffect(() => {
    if (selectMode && !selected.size) setSelectMode(false)
  }, [selectMode, selected])

  // 离开底部超过 100px 时显示"回到底部"按钮
  useEffect(() => {
    const el = document.querySelector<HTMLDivElement>('.message-list')
    if (!el) return
    const onScroll = () => setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 100)
    onScroll()
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 对齐到底部：直接钉 DOM scrollTop 到最大（scrollToIndex 停在末条条目末尾，不含末尾占位行），
  // 布局未稳定时有界重试
  const scrollToEnd = () => {
    let tries = 0
    const step = () => {
      const el = document.querySelector<HTMLDivElement>('.message-list')
      if (!el) return
      el.scrollTop = el.scrollHeight - el.clientHeight
      tries++
      requestAnimationFrame(() => {
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 10 && tries < 10) step()
      })
    }
    step()
  }

  // 挂载时（首次加载/切换会话：App 用 key 按会话重挂载）钉到底部：
  // Virtuoso 挂载后 1 秒内会持续修正条目高度估算，期间每次内容变化都把
  // scrollTop 钉到最大（直接操作 DOM，不依赖 Virtuoso 内部状态）
  useEffect(() => {
    const el = document.querySelector<HTMLDivElement>('.message-list')
    if (!el) return
    const start = Date.now()
    const pin = () => {
      if (Date.now() - start > 1000) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
        el.scrollTop = el.scrollHeight - el.clientHeight
      }
    }
    pin()
    const ro = new ResizeObserver(pin)
    ro.observe(el)
    const t = setInterval(pin, 100)
    return () => {
      ro.disconnect()
      clearInterval(t)
    }
  }, [])

  // 发送/重试后强制回到底部（只跟 resetKey，条目增长本身不触发，避免打断上滚阅读）
  useEffect(() => {
    scrollToEnd()
  }, [resetKey])

  return (
    <div className="relative flex-1 min-h-0">
      <Virtuoso
        ref={ref}
        className="message-list h-full"
        data={[...history, null]}
        initialTopMostItemIndex={Math.max(0, history.length - 1)}
        followOutput="smooth"
        alignToBottom
        itemContent={(index, entry) =>
          entry == null ? (
            // 末尾 96px 占位：钉底时最后一条的按钮行落在输入框上沿之上，露出来可点
            <div className="h-24" />
          ) : (
            <div className={cn('mx-auto w-full max-w-3xl px-4 pb-3', index === 0 && 'pt-4')}>
              <MessageRow
                entry={entry}
                busy={busy}
                generating={genId === entry.id}
                executing={executingId === entry.id}
                onEdit={(patch) => onEdit(entry.id, patch)}
                onDelete={() => onDelete(entry.id)}
                onRetry={() => onRetry(entry.id)}
                ttsActive={ttsActiveId === entry.id}
                ttsLoading={ttsLoadingId === entry.id}
                onTts={(text) => onTts(entry.id, text)}
                selected={selected.has(entry.id)}
                onToggleSelect={() =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (next.has(entry.id)) next.delete(entry.id)
                    else next.add(entry.id)
                    return next
                  })
                }
                selectMode={selectMode}
                onEnterSelectMode={(id) => {
                  setSelectMode(true)
                  setSelected(new Set([id]))
                }}
              />
            </div>
          )
        }
      />
      {showJump && selected.size === 0 && (
        <button
          type="button"
          title="回到底部"
          onClick={scrollToEnd}
          className="absolute bottom-24 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md hover:bg-accent hover:text-foreground"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
      {selected.size > 0 && (
        <div className="absolute bottom-24 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background py-1.5 pl-3 pr-1.5 shadow-md">
          <span className="text-xs text-muted-foreground">已选 {selected.size} 条</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => setConfirmBulk(true)}
          >
            删除
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            title="取消选择"
            onClick={() => setSelected(new Set())}
          >
            <X />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`删除已选的 ${selected.size} 条？`}
        description="绑定的工具结果/调用气泡会被一并删除"
        onConfirm={() => {
          onBulkDelete([...selected])
          setSelected(new Set())
        }}
      />
    </div>
  )
}