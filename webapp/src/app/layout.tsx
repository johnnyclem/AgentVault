import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '../providers/ThemeProvider'
import { ICProvider } from '../providers/ICProvider'
import { themeInitScript } from '../lib/theme'

export const metadata: Metadata = {
  title: 'AgentVault - AI Agent Platform',
  description: 'Manage persistent AI agents on the Internet Computer',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // The head script sets the theme class before React hydrates, so the
    // class attribute on <html> legitimately differs from the server render.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <ICProvider>
            <div className="min-h-screen bg-background text-foreground">
              {children}
            </div>
          </ICProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
