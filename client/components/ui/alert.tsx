import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// 通知卡片壳：实底 + 边框 + 阴影；变体只调边框色（图标色由调用方按变体指定）
const alertVariants = cva(
  "relative w-full rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-md",
  {
    variants: {
      variant: {
        info: "",
        warning: "border-amber-500/50",
        error: "border-destructive/50",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-medium leading-none tracking-normal", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("mt-1 text-sm text-muted-foreground [&_p]:leading-relaxed", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, alertVariants }
