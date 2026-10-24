/*
 * Dashboard preferences kept in this browser's localStorage. Nothing else in
 * the dashboard reads them yet (the theme lives in ThemeProvider), so the
 * settings page says only that they are saved here. Storage can be missing or
 * blocked (server render, private windows, sandboxed frames), so every access
 * is guarded and a stored value that fails validation falls back to its default.
 */

export interface DashboardSettings {
  autoRefresh: boolean
  /** Seconds, within REFRESH_INTERVAL */
  refreshInterval: number
  notifications: boolean
  sound: boolean
  autoBackup: boolean
  /** Hours, within BACKUP_INTERVAL */
  backupInterval: number
}

export interface IntervalBounds {
  min: number
  max: number
}

export const REFRESH_INTERVAL: IntervalBounds = { min: 10, max: 300 }
export const BACKUP_INTERVAL: IntervalBounds = { min: 1, max: 168 }

export const DEFAULT_SETTINGS: DashboardSettings = {
  autoRefresh: true,
  refreshInterval: 30,
  notifications: true,
  sound: false,
  autoBackup: true,
  backupInterval: 24,
}

export const SETTINGS_STORAGE_KEY = 'agentvault-settings'

/**
 * A whole number within bounds. An empty field or anything that is not a
 * number (parseInt('') is NaN) keeps `fallback` instead of being saved.
 */
export function clampInterval(value: unknown, bounds: IntervalBounds, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value)
    : NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)))
}

export function parseSettings(raw: string | null): DashboardSettings {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    // A corrupt entry is treated like no entry.
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...DEFAULT_SETTINGS }

  const stored = data as Record<string, unknown>
  const flag = (key: 'autoRefresh' | 'notifications' | 'sound' | 'autoBackup') => {
    const value = stored[key]
    return typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key]
  }

  return {
    autoRefresh: flag('autoRefresh'),
    refreshInterval: clampInterval(stored.refreshInterval, REFRESH_INTERVAL, DEFAULT_SETTINGS.refreshInterval),
    notifications: flag('notifications'),
    sound: flag('sound'),
    autoBackup: flag('autoBackup'),
    backupInterval: clampInterval(stored.backupInterval, BACKUP_INTERVAL, DEFAULT_SETTINGS.backupInterval),
  }
}

/** Returns null when the browser will not let us read storage at all. */
export function loadSettings(): DashboardSettings | null {
  try {
    return parseSettings(window.localStorage.getItem(SETTINGS_STORAGE_KEY))
  } catch {
    return null
  }
}

/** Returns false when the browser refused to store them. */
export function saveSettings(settings: DashboardSettings): boolean {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}
