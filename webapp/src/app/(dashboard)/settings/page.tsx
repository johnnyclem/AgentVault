'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Bell, Check, Globe, Lock, Monitor, Moon, Palette, Sun, TriangleAlert } from 'lucide-react'
import { useTheme } from '@/providers/ThemeProvider'
import { cn } from '@/lib/utils'
import {
  BACKUP_INTERVAL,
  DEFAULT_SETTINGS,
  REFRESH_INTERVAL,
  clampInterval,
  loadSettings,
  saveSettings,
  type DashboardSettings,
  type IntervalBounds,
} from './settings-storage'

/*
 * Only the theme changes anything; the other options are stored preferences
 * that no page reads (see settings-storage.ts). Each pane says so under its
 * title, and the rows describe the preference rather than a behaviour, so a
 * toggle that is on never reads as a feature that is running.
 */
const SECTIONS = [
  { id: 'appearance', label: 'Appearance', description: 'How the dashboard looks in this browser.', icon: Palette },
  {
    id: 'network',
    label: 'Network',
    description: 'Refresh preferences, saved in this browser. No page uses them.',
    icon: Globe,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Alert preferences, saved in this browser. No page uses them.',
    icon: Bell,
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Backup preferences, saved in this browser. Nothing runs backups on this schedule.',
    icon: Lock,
  },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const THEMES = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const

export default function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const [section, setSection] = useState<SectionId>('appearance')
  const [settings, setSettings] = useState<DashboardSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [storageBlocked, setStorageBlocked] = useState(false)

  // Stored values are read after mount: the server render has no storage, and
  // reading it during the first client render would not match the server HTML.
  // ThemeProvider restores the stored theme after mount as well, so no theme
  // button is shown as selected until then.
  useEffect(() => {
    const stored = loadSettings()
    if (stored) setSettings(stored)
    setStorageBlocked(!stored)
    setLoaded(true)
  }, [])

  const update = (patch: Partial<DashboardSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    setStorageBlocked(!saveSettings(next))
  }

  const current = SECTIONS.find(({ id }) => id === section) ?? SECTIONS[0]

  return (
    <div className="page max-w-4xl">
      <div className="space-y-1">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Preferences for this dashboard.</p>
      </div>

      <div className="surface overflow-hidden md:flex">
        <nav
          aria-label="Settings sections"
          className="flex gap-1 overflow-x-auto border-b border-border p-2 md:w-52 md:shrink-0 md:flex-col md:border-b-0 md:border-r"
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={section === id ? 'true' : undefined}
              className={cn('nav-item shrink-0 whitespace-nowrap max-md:rounded-full', section === id && 'nav-item-active')}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>

        <section className="min-w-0 flex-1 p-4 md:p-6" aria-labelledby="settings-pane-title">
          <h2 id="settings-pane-title" className="text-base font-semibold">{current.label}</h2>
          <p className="text-sm text-muted-foreground">{current.description}</p>

          <div className="mt-4 divide-y divide-border">
            {section === 'appearance' && (
              <SettingRow title="Theme" description="Light, dark, or match your system.">
                <div role="group" aria-label="Theme" className="inline-flex rounded-lg border border-border p-0.5">
                  {THEMES.map(({ id, label, icon: Icon }) => {
                    const active = loaded && theme === id
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setTheme(id)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
                          active && 'bg-secondary text-foreground'
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        {label}
                      </button>
                    )
                  })}
                </div>
              </SettingRow>
            )}

            {section === 'network' && (
              <>
                <SettingRow title="Auto refresh" description="Whether you'd like network data refreshed on a timer.">
                  <Toggle label="Auto refresh" checked={settings.autoRefresh} onChange={(autoRefresh) => update({ autoRefresh })} />
                </SettingRow>
                {settings.autoRefresh && (
                  <IntervalField
                    id="refresh-interval"
                    title="Refresh interval"
                    unit="seconds"
                    bounds={REFRESH_INTERVAL}
                    value={settings.refreshInterval}
                    onCommit={(refreshInterval) => update({ refreshInterval })}
                  />
                )}
              </>
            )}

            {section === 'notifications' && (
              <>
                <SettingRow title="Notifications" description="Whether you'd like alerts for important events.">
                  <Toggle label="Notifications" checked={settings.notifications} onChange={(notifications) => update({ notifications })} />
                </SettingRow>
                <SettingRow title="Sound" description="Whether you'd like a sound with each alert.">
                  <Toggle label="Sound" checked={settings.sound} onChange={(sound) => update({ sound })} />
                </SettingRow>
              </>
            )}

            {section === 'security' && (
              <>
                <SettingRow
                  title="Auto backup"
                  description={
                    <>
                      The schedule you&apos;d like backups on. To make one now, run{' '}
                      <code className="font-mono text-foreground">agentvault backup export &lt;agent-name&gt;</code>.
                    </>
                  }
                >
                  <Toggle label="Auto backup" checked={settings.autoBackup} onChange={(autoBackup) => update({ autoBackup })} />
                </SettingRow>
                {settings.autoBackup && (
                  <IntervalField
                    id="backup-interval"
                    title="Backup interval"
                    unit="hours"
                    bounds={BACKUP_INTERVAL}
                    value={settings.backupInterval}
                    onCommit={(backupInterval) => update({ backupInterval })}
                  />
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground" aria-live="polite">
        {storageBlocked ? (
          <>
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            Not saved: this browser is blocking local storage, so changes last until you reload.
          </>
        ) : (
          <>
            <Check className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Saved in this browser. The theme applies across the dashboard; the other options are kept as
            preferences and don&apos;t change other pages.
          </>
        )}
      </p>
    </div>
  )
}

function SettingRow({
  title,
  description,
  htmlFor,
  children,
}: {
  title: string
  description: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">{title}</label>
        ) : (
          <p className="text-sm font-medium">{title}</p>
        )}
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        // A mid-grey off track rather than bg-input: the track against the card, and the
        // bg-background knob against the track, then clear 3:1 in both themes.
        checked ? 'bg-primary' : 'bg-muted-foreground/70'
      )}
    >
      <span
        className={cn(
          'inline-block h-5 w-5 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

/**
 * A number field that saves as soon as it holds a valid whole number in range.
 * Anything else (an empty field, a half-typed or out-of-range value) waits for
 * blur and is then clamped, so a NaN or stray value is never stored.
 */
function IntervalField({
  id,
  title,
  unit,
  bounds,
  value,
  onCommit,
}: {
  id: string
  title: string
  unit: string
  bounds: IntervalBounds
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const isValid = (n: number) => Number.isInteger(n) && n >= bounds.min && n <= bounds.max

  return (
    <SettingRow title={title} description={`Between ${bounds.min} and ${bounds.max}.`} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            const next = Number(event.target.value)
            if (event.target.value !== '' && isValid(next) && next !== value) onCommit(next)
          }}
          onBlur={() => {
            const next = clampInterval(draft, bounds, value)
            setDraft(String(next))
            if (next !== value) onCommit(next)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
    </SettingRow>
  )
}
