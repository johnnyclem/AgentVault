'use client'

import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useTheme } from '@/providers/ThemeProvider'
import type { Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const OPTIONS: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
  { value: 'system', label: 'System theme', icon: Monitor },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  // The stored theme is read after hydration, so nothing is marked as selected
  // until then rather than briefly highlighting the default.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <div role="group" aria-label="Theme" className="inline-flex shrink-0 items-center gap-0.5 rounded-full border bg-card p-0.5">
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = mounted && theme === value

        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground',
              selected && 'bg-secondary text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        )
      })}
    </div>
  )
}
