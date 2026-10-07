import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/35 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-indigo-400/20 bg-gradient-to-b from-indigo-500 to-indigo-600 text-white shadow-[0_8px_22px_rgba(79,70,229,.24)] hover:from-indigo-400 hover:to-indigo-500 hover:shadow-[0_10px_28px_rgba(79,70,229,.34)]",
        destructive:
          "border border-rose-400/20 bg-gradient-to-b from-rose-500 to-rose-600 text-white shadow-[0_8px_22px_rgba(225,29,72,.2)] hover:from-rose-400 hover:to-rose-500",
        outline:
          "border border-white/[0.1] bg-white/[0.025] text-slate-200 shadow-sm hover:border-white/[0.17] hover:bg-white/[0.06] hover:text-white",
        secondary:
          "border border-white/[0.08] bg-slate-800/75 text-slate-200 hover:bg-slate-700/80 hover:text-white",
        ghost:
          "border border-transparent bg-transparent text-slate-400 hover:bg-white/[0.05] hover:text-white",
        link: "text-indigo-300 underline-offset-4 hover:text-indigo-200 hover:underline",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-lg px-3 text-xs",
        lg: "min-h-10 rounded-xl px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
