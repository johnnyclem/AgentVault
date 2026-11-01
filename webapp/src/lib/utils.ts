import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: bigint | number): string {
  const num = typeof bytes === 'bigint' ? Number(bytes) : bytes
  if (num === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(num) / Math.log(k))

  return `${parseFloat((num / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function formatCycles(cycles: bigint | number): string {
  const num = typeof cycles === 'bigint' ? Number(cycles) : cycles
  // Zero reads in the same unit as every other balance: "0.00 T" beside "4.20 T".
  if (num === 0) {
    return '0.00 T'
  }
  if (num < 1_000_000) {
    return `${num.toLocaleString()} T`
  }
  if (num < 1_000_000_000) {
    return `${(num / 1_000_000).toFixed(2)} M`
  }
  if (num < 1_000_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(2)} G`
  }
  return `${(num / 1_000_000_000_000).toFixed(2)} T`
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * The one date rule: relative for the last 30 days ("4d ago"), then a plain
 * calendar date ("Oct 19, 2026"). A date alone never reads as 10/19 or 19/10.
 */
export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '—'

  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 30) return `${days}d ago`

  return DATE_FORMAT.format(date)
}

export function formatDateTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString()
}

export function formatDate(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '—' : DATE_FORMAT.format(date)
}

export function truncate(str: string, length: number = 20): string {
  if (str.length <= length) return str
  return `${str.slice(0, length)}…`
}

/** One head and tail length for every principal and address: "rrkah-fq…aaaq-cai". */
export function truncatePrincipal(principal: string, length: number = 8): string {
  if (principal.length <= length * 2) return principal
  return `${principal.slice(0, length)}…${principal.slice(-length)}`
}

/**
 * Status colours map onto the semantic tokens in globals.css, which are
 * redefined for dark mode, so one class reads well in both themes.
 */
const STATUS_TONE: Record<string, 'success' | 'info' | 'warning' | 'neutral' | 'danger'> = {
  running: 'success',
  active: 'success',
  connected: 'success',
  completed: 'success',
  approved: 'success',
  uploading: 'info',
  submitted: 'info',
  deploying: 'info',
  pending: 'warning',
  starting: 'warning',
  stopping: 'warning',
  degraded: 'warning',
  stopped: 'neutral',
  inactive: 'neutral',
  disconnected: 'neutral',
  expired: 'neutral',
  error: 'danger',
  failed: 'danger',
  rejected: 'danger',
}

const TONE_TEXT = {
  success: 'text-success',
  info: 'text-primary',
  warning: 'text-warning',
  neutral: 'text-muted-foreground',
  danger: 'text-destructive',
} as const

const TONE_BADGE = {
  success: 'bg-success/15 text-success',
  info: 'bg-primary/10 text-primary',
  warning: 'bg-warning/15 text-warning',
  neutral: 'bg-muted text-muted-foreground',
  danger: 'bg-destructive/10 text-destructive',
} as const

export function getStatusColor(status: string): string {
  return TONE_TEXT[STATUS_TONE[status.toLowerCase()] ?? 'neutral']
}

/** A tinted background plus matching text colour, for pills and badges. */
export function getStatusBgColor(status: string): string {
  return TONE_BADGE[STATUS_TONE[status.toLowerCase()] ?? 'neutral']
}
