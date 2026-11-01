'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { BrandMark } from './BrandMark'
import { BOTTOM_NAV, NAV_GROUPS, isNavItemActive, type NavItem } from './nav'

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn('nav-item', active && 'nav-item-active')}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {item.label}
    </Link>
  )
}

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden h-full w-60 shrink-0 flex-col border-r bg-muted/40 md:flex">
      <div className="flex h-14 items-center px-6">
        <BrandMark />
      </div>

      <nav aria-label="Sections" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-0.5">
            <p className="px-3 pb-2 text-xs text-muted-foreground">{group.label}</p>
            {group.items.map((item) => (
              <SidebarLink key={item.href} item={item} active={isNavItemActive(pathname, item.href)} />
            ))}
          </div>
        ))}
      </nav>

      <nav aria-label="Preferences" className="border-t px-3 py-3">
        {BOTTOM_NAV.map((item) => (
          <SidebarLink key={item.href} item={item} active={isNavItemActive(pathname, item.href)} />
        ))}
      </nav>
    </aside>
  )
}
