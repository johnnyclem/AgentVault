import type { LucideIcon } from 'lucide-react'
import { Archive, Blocks, Bot, DatabaseBackup, ListChecks, Network, Server, Settings, Vault, Wallet } from 'lucide-react'

export interface NavItem {
  label: string
  href: string
  icon: LucideIcon
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

/**
 * The one list of dashboard sections. The sidebar, the mobile pill row and the
 * header breadcrumb all read it, so a route only has to be added here once.
 * Every href must have a page under app/(dashboard).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Agents',
    items: [
      { label: 'Agents', href: '/agents', icon: Bot },
      { label: 'Tasks', href: '/tasks', icon: ListChecks },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Canisters', href: '/canisters', icon: Server },
      { label: 'Networks', href: '/networks', icon: Network },
      { label: 'On-chain', href: '/on-chain', icon: Blocks },
    ],
  },
  {
    label: 'Vault',
    items: [
      { label: 'Vault', href: '/vault', icon: Vault },
      { label: 'Wallets', href: '/wallets', icon: Wallet },
      { label: 'Backups', href: '/backups', icon: DatabaseBackup },
      { label: 'Archives', href: '/archives', icon: Archive },
    ],
  },
]

export const BOTTOM_NAV: NavItem[] = [
  { label: 'Settings', href: '/settings', icon: Settings },
]

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flatMap((group) => group.items), ...BOTTOM_NAV]

/** A section stays active on its detail pages too (/agents/abc lights up Agents). */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  return pathname === href || Boolean(pathname?.startsWith(`${href}/`))
}

export function findNavItem(pathname: string | null): NavItem | undefined {
  return ALL_NAV_ITEMS.find((item) => isNavItemActive(pathname, item.href))
}

export interface Crumb {
  label: string
  /** Set when the crumb is a page of its own */
  href?: string
  /** An agent id or similar, drawn as a reference tag */
  isId?: boolean
}

const SEGMENT_LABELS: Record<string, string> = {
  config: 'Configure',
  proof: 'Evidence',
  'memory-writes': 'Signed memory writes',
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The header's breadcrumb. A top-level section has none, because its page title
 * already names it and the sidebar marks it; a detail page gets
 * "Agents / agent-7f3a91c2 / Configure" so there is a way up and a place on the map.
 */
export function breadcrumbsFor(pathname: string | null): Crumb[] {
  const section = findNavItem(pathname)
  if (!section || !pathname || pathname === section.href) return []

  const rest = pathname.slice(section.href.length).split('/').filter(Boolean)
  const crumbs: Crumb[] = [{ label: section.label, href: section.href }]
  let href: string = section.href

  rest.forEach((segment, index) => {
    href = `${href}/${segment}`
    const label = SEGMENT_LABELS[segment]
    const isLast = index === rest.length - 1
    // /agents/<id> is a page of its own; /vault/<id> only exists as /vault/<id>/proof.
    const linkable = !isLast && !label && section.href === '/agents'
    crumbs.push(
      label
        ? { label }
        : { label: decodeSegment(segment), isId: true, href: linkable ? href : undefined }
    )
  })

  return crumbs
}
