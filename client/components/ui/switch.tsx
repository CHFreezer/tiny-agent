import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import type { SwitchRootProps } from "@base-ui/react/switch"
import { cn } from "cn"

function Switch({ className, ...props }: SwitchRootProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent bg-input transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-checked:bg-primary dark:bg-input/80",
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-lg transition-transform data-checked:translate-x-[calc(100%-2px)] dark:data-checked:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }