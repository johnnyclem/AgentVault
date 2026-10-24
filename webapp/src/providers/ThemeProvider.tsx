'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { THEME_STORAGE_KEY, isTheme, type Theme } from '@/lib/theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  actualTheme: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function ThemeProvider({ children, defaultTheme = 'system' }: { children: ReactNode, defaultTheme?: Theme }) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme)
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light')
  // The server cannot know the stored choice, so state starts at the default and
  // the <html> class is left to the inline head script until storage has been read.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
      if (isTheme(stored)) setThemeState(stored)
    } catch {
      // Storage can be blocked (private mode, sandboxed frames); keep the default.
    }

    const media = window.matchMedia(DARK_QUERY)
    const sync = () => setSystemTheme(media.matches ? 'dark' : 'light')
    sync()
    media.addEventListener('change', sync)
    setReady(true)
    return () => media.removeEventListener('change', sync)
  }, [])

  const actualTheme = theme === 'system' ? systemTheme : theme

  useEffect(() => {
    if (!ready) return
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(actualTheme)
  }, [ready, actualTheme])

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, newTheme)
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, actualTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
