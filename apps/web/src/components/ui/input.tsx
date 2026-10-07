import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-lg border border-white/[0.09] bg-slate-950/45 px-3 py-1 text-base text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,.025)] transition-all placeholder:text-slate-500 focus-visible:border-indigo-400/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/10 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
