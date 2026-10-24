'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { ALL_NAV_ITEMS, isNavItemActive } from './nav'

/** Below md the sidebar is hidden; this scrollable pill row replaces it. */
export function MobileNav() {
  const pathname = usePathname()
  const activeRef = useRef<HTMLAnchorElement>(null)

  // Sections near the end of the row start off-screen; bring the current one into
  // view. Each pill's scroll-mx-4 matches the row's px-4, so it stops a gutter
  // short of the edge instead of sitting flush against it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pathname])

  return (
    <nav aria-label="Sections" className="shrink-0 overflow-x-auto border-b [scrollbar-width:none] md:hidden">
      <div className="flex w-max gap-1.5 px-4 py-2">
        {ALL_NAV_ITEMS.map((item) => {
          const active = isNavItemActive(pathname, item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              ref={active ? activeRef : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn('chip scroll-mx-4 whitespace-nowrap', active && 'chip-active')}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
