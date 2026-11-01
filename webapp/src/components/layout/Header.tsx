'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BrandMark } from './BrandMark'
import { ThemeToggle } from './ThemeToggle'
import { breadcrumbsFor } from './nav'

export function Header() {
  const pathname = usePathname()
  const crumbs = breadcrumbsFor(pathname)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="md:hidden">
          <BrandMark withName={false} />
        </div>
        {crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-2 text-sm">
              {crumbs.map((crumb, index) => {
                const isLast = index === crumbs.length - 1
                const label = crumb.isId ? (
                  <span className="tag" title={crumb.label}>{crumb.label}</span>
                ) : (
                  crumb.label
                )

                return (
                  <li key={`${index}-${crumb.label}`} className={cn('flex items-center gap-2', index === 0 ? 'shrink-0' : 'min-w-0')}>
                    {index > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    {crumb.href && !isLast ? (
                      <Link href={crumb.href} className="min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground">
                        {label}
                      </Link>
                    ) : (
                      <span aria-current={isLast ? 'page' : undefined} className={cn('min-w-0 truncate', isLast ? 'font-medium' : 'text-muted-foreground')}>
                        {label}
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </nav>
        )}
      </div>
      <ThemeToggle />
    </header>
  )
}
