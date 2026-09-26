import { useEffect, useState } from 'react'
import { PanelLeft, Gauge, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const EFFORT_OPTIONS = [
  { value: '', label: '标准' },
  { value: 'none', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

export function Header({
  effort,
  status,
  lastPromptTokens,
  lastCompletionTokens,
  maxContext,
  busy,
  onToggleSidebar,
  onEffortChange,
  onOpenSettings,
  onCompact,
  onRefreshUsage,
}: {
  effort: string
  status: string
  lastPromptTokens?: number
  lastCompletionTokens?: number
  maxContext: number
  busy: boolean
  onToggleSidebar: () => void
  onEffortChange: (v: string) => void
  onOpenSettings: () => void
  onCompact: () => void
  onRefreshUsage: () => Promise<boolean>
}) {
  const [measuring, setMeasuring] = useState(false)
  // 精确值到手（生成结束/刷新完成）后停止"测量中"提示
  useEffect(() => {
    if (lastPromptTokens && lastPromptTokens > 0) setMeasuring(false)
  }, [lastPromptTokens])
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))
  // 面板主数值：精确（上次请求上游实测 prompt + 响应 completion = 上次响应结束时的真实上下文）
  const exact = lastPromptTokens && lastPromptTokens > 0 ? lastPromptTokens + (lastCompletionTokens ?? 0) : null
  const overflow = exact != null && maxContext > 0 && exact > maxContext
  const pctExact = exact != null && maxContext > 0 ? Math.min(100, Math.round((exact / maxContext) * 100)) : null
  return (
    <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
      <Button size="icon-sm" variant="ghost" title="收起/展开侧边栏" onClick={onToggleSidebar}>
        <PanelLeft />
      </Button>
      <h1 className="text-lg font-semibold m-0 shrink-0 whitespace-nowrap">tiny-agent</h1>
      <span className="text-xs text-muted-foreground">{status}</span>
      <div className="ml-auto flex items-center gap-2">
          <Popover
            onOpenChange={(open) => {
              // 无精确值（旧会话）：打开面板时向上游实测一次
              if (open && (!lastPromptTokens || lastPromptTokens <= 0)) {
                setMeasuring(true)
                void onRefreshUsage().then((ok) => {
                  if (!ok) setMeasuring(false)
                })
              }
            }}
          >
            <PopoverTrigger
              nativeButton={false}
              render={
                <span
                  className={cn(
                    'flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-xs tabular-nums transition-colors hover:bg-accent',
                    pctExact != null && pctExact >= 95 ? 'text-red-500' : pctExact != null && pctExact >= 80 ? 'text-amber-500' : 'text-muted-foreground',
                  )}
                  title={
                    exact != null
                      ? maxContext > 0
                        ? `当前上下文 ${exact} / ${maxContext} token（${pctExact}%）`
                        : `当前上下文 ${exact} token（未设窗口上限）`
                      : '当前上下文（尚无精确用量，点击实测）'
                  }
                />
              }
            >
              <Gauge className="size-3.5 shrink-0 sm:hidden" />
              <span className="hidden sm:inline">用量 </span>
              {exact != null && maxContext > 0 ? (
                <>
                  <span className="hidden sm:inline">
                    {fmt(exact)} / {fmt(maxContext)} ·{' '}
                  </span>
                  {pctExact}%
                </>
              ) : exact != null ? (
                fmt(exact)
              ) : null}
            </PopoverTrigger>
            <PopoverContent className="w-64 gap-2 p-3" align="end">
              <div className="text-xs text-muted-foreground">当前上下文用量</div>
              <div className="text-sm tabular-nums">
                {exact != null ? (
                  <>
                    <span className={cn('font-medium', overflow && 'text-red-500')}>{exact.toLocaleString()}</span>
                    {maxContext > 0 && (
                      <span className="text-muted-foreground">
                        {' '}
                        / {maxContext.toLocaleString()} token（{pctExact}%）
                      </span>
                    )}
                    {overflow ? (
                      <div className="mt-1 text-xs text-red-500">已超窗口，压缩无法成功，请删除部分消息</div>
                    ) : (
                      <div className="mt-1 text-xs text-muted-foreground">精确值（上次请求实测）</div>
                    )}
                  </>
                ) : (
                  <>
                    <span className="font-medium">—</span>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {measuring ? '正在向上游实测精确用量…' : '尚无精确用量（打开面板自动实测）'}
                    </div>
                  </>
                )}
              </div>
              <Button size="sm" variant="outline" className="w-full" disabled={busy || overflow} onClick={onCompact}>
                {busy ? '压缩中…' : '压缩上下文'}
              </Button>
            </PopoverContent>
          </Popover>
        <span className="hidden text-xs text-muted-foreground sm:inline">思考强度</span>
        <Brain className="size-3.5 shrink-0 sm:hidden" />
        <Select value={effort} onValueChange={(v) => onEffortChange(v ?? '')}>
          <SelectTrigger className="w-[80px]">
            <span className="truncate">{EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? "标准"}</span>
          </SelectTrigger>
          <SelectContent>
            {EFFORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={onOpenSettings}>
          设置
        </Button>
      </div>
    </header>
  )
}