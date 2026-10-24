import { ShieldCheck } from 'lucide-react'

export function BrandMark({ withName = true }: { withName?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
        <ShieldCheck className="h-4 w-4" />
      </span>
      {withName && <span className="text-sm font-semibold tracking-tight">AgentVault</span>}
    </div>
  )
}
