import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#00d4aa] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[#00d4aa15] text-[#00d4aa]",
        secondary: "border-transparent bg-[#1c1c24] text-[#88889a]",
        destructive: "border-transparent bg-[#ff475718] text-[#ff4757]",
        outline: "text-[#e8e8ed] border-[#2a2a38]",
        amber: "border-transparent bg-[#f49b3e15] text-[#f49b3e]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
