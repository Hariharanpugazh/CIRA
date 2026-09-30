import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-[#2a2a38] bg-[#0f0f12] px-3 py-1 text-sm text-[#e8e8ed] placeholder:text-[#5c5c6e] focus:border-[#00d4aa] focus:outline-none focus:ring-1 focus:ring-[#00d4aa] disabled:cursor-not-allowed disabled:opacity-50",
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
