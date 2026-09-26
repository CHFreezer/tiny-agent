import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

export interface Notification {
  id: number
  title: string
  description?: string
  variant: 'info' | 'warning' | 'error'
}
const ICONS = {
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
} as const

const ICON_COLOR = {
  info: 'text-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
} as const

// 通知栈：右上角竖排叠加；error 常驻，info/warning 由调用方超时移除；均可手动关闭
export function NotificationStack({
  items,
  onDismiss,
}: {
  items: Notification[]
  onDismiss: (id: number) => void
}) {
  return (
    <div className="fixed right-4 top-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((n) => {
        const Icon = ICONS[n.variant]
        return (
          <Alert key={n.id} variant={n.variant}>
            <div className="flex items-start gap-3">
              <Icon className={cn('mt-0.5 size-4 shrink-0', ICON_COLOR[n.variant])} />
              <div className="min-w-0 flex-1 pr-5">
                <AlertTitle>{n.title}</AlertTitle>
                {n.description ? <AlertDescription>{n.description}</AlertDescription> : null}
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => onDismiss(n.id)}
                className="absolute right-3 top-3 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </Alert>
        )
      })}
    </div>
  )
}
