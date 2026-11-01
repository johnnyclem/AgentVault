import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '../providers/ThemeProvider'
import { ICProvider } from '../providers/ICProvider'
import { themeInitScript } from '../lib/theme'

export const metadata: Metadata = {
  title: 'AgentVault',
  description:
    'Deploy AI agents to Internet Computer canisters, archive them to Arweave and check the receipts in your browser',
}

// next/font fetches the families at build time and serves them from this app's
// own origin, so the dashboard makes no request to Google while it runs and
// nothing blocks the first paint. tailwind.config.ts reads the two variables.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-plex-sans',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-plex-mono',
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // The head script sets the theme class before React hydrates, so the
    // class attribute on <html> legitimately differs from the server render.
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
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
