export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'agentvault-theme'

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * Runs in <head> before first paint so a stored or OS-preferred dark theme is
 * applied before any pixels render; ThemeProvider takes over after hydration.
 * It lives outside the 'use client' provider module because a server layout
 * importing a constant from a client module gets a reference, not the string.
 */
export const themeInitScript = `(function(){var t;try{t=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.classList.add(t)})()`
