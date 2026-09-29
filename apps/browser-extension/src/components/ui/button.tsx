import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#00d4aa] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-[#1c1c24] text-[#e8e8ed] border border-[#2a2a38] hover:bg-[#242431]",
        destructive: "bg-[#ff475725] text-[#ff4757] border border-[#ff475740] hover:bg-[#ff475735]",
        outline: "border border-[#2a2a38] bg-transparent text-[#e8e8ed] hover:bg-[#1c1c24]",
        secondary: "bg-[#242431] text-[#e8e8ed] hover:bg-[#2a2a38]",
        ghost: "text-[#e8e8ed] hover:bg-[#1c1c24]",
        link: "text-[#00d4aa] underline-offset-4 hover:underline",
        teal: "bg-[#00d4aa15] text-[#00d4aa] border border-[#00d4aa30] hover:bg-[#00d4aa25]",
        amber: "bg-[#f49b3e15] text-[#f49b3e] border border-[#f49b3e30] hover:bg-[#f49b3e25]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
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
