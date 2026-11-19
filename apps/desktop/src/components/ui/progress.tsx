import * as React from "react"
import { cn } from "@/lib"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      value={value ?? null}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("h-full bg-primary transition-all", value == null ? "w-1/3 animate-pulse" : "w-full flex-1")}
        style={value == null ? undefined : { transform: `translateX(-${100 - value}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
