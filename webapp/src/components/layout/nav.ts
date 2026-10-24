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
 * header title all read it, so a route only has to be added here once. Every
 * href must have a page under app/(dashboard).
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
