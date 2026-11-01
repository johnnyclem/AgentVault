import { cn, getStatusBgColor } from '@/lib/utils'

interface StatusBadgeProps {
  status: string
  className?: string
  showDot?: boolean
}

export function StatusBadge({ status, className, showDot = true }: StatusBadgeProps) {
  const bgColor = getStatusBgColor(status)

  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium', bgColor, className)}>
      {showDot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      <span className="capitalize">{status}</span>
    </span>
  )
}
