import { PanelLeft, Gauge, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'

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
  contextTokens,
  maxContext,
  onToggleSidebar,
  onEffortChange,
  onOpenSettings,
}: {
  effort: string
  status: string
  contextTokens?: number
  maxContext: number
  onToggleSidebar: () => void
  onEffortChange: (v: string) => void
  onOpenSettings: () => void
}) {
  const pct = contextTokens != null && maxContext > 0 ? Math.min(100, Math.round((contextTokens / maxContext) * 100)) : null
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))
  return (
    <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
      <Button size="icon-sm" variant="ghost" title="收起/展开侧边栏" onClick={onToggleSidebar}>
        <PanelLeft />
      </Button>
      <h1 className="text-lg font-semibold m-0 shrink-0 whitespace-nowrap">tiny-agent</h1>
      <span className="text-xs text-muted-foreground">{status}</span>
      <div className="ml-auto flex items-center gap-2">
        {contextTokens != null && (
          <span
            className={cn(
              'flex items-center gap-1 text-xs tabular-nums',
              pct != null && pct >= 95 ? 'text-red-500' : pct != null && pct >= 80 ? 'text-amber-500' : 'text-muted-foreground',
            )}
            title={maxContext > 0 ? `当前上下文 ${contextTokens} / ${maxContext} token（${pct}%）` : `当前上下文 ${contextTokens} token（未设窗口上限）`}
          >
            <Gauge className="size-3.5 shrink-0 sm:hidden" />
            <span className="hidden sm:inline">用量 </span>
            {pct != null ? (
              <>
                <span className="hidden sm:inline">
                  {fmt(contextTokens)} / {fmt(maxContext)} ·{' '}
                </span>
                {pct}%
              </>
            ) : (
              fmt(contextTokens)
            )}
          </span>
        )}
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