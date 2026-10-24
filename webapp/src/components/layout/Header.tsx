'use client'

import { usePathname } from 'next/navigation'
import { BrandMark } from './BrandMark'
import { ThemeToggle } from './ThemeToggle'
import { findNavItem } from './nav'

export function Header() {
  const pathname = usePathname()
  const title = findNavItem(pathname)?.label ?? 'AgentVault'

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="md:hidden">
          <BrandMark withName={false} />
        </div>
        <span className="truncate text-sm font-medium">{title}</span>
      </div>
      <ThemeToggle />
    </header>
  )
}
