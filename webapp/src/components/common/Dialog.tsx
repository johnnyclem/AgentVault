'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface DialogProps {
  /** The id of the heading that names the dialog */
  labelledBy: string
  /**
   * Called when the person presses Escape. Leave it out while the dialog has to
   * stay open, for instance while a request it started is still running.
   */
  onClose?: () => void
  /** Classes for the dimmed backdrop that holds the panel */
  className?: string
  /** Classes for the panel itself: its width and padding */
  panelClassName?: string
  children: ReactNode
}

/**
 * A modal dialog that behaves like one for the keyboard: focus moves into it
 * when it opens, Tab stays inside it, Escape closes it, and focus goes back to
 * the control that opened it when it closes.
 */
export function Dialog({ labelledBy, onClose, className, panelClassName, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const panel = panelRef.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The panel itself takes focus first, so a screen reader reads the dialog's name before its first control.
    panel?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (!panel) return

      if (event.key === 'Escape') {
        if (onCloseRef.current) {
          event.preventDefault()
          onCloseRef.current()
        }
        return
      }

      if (event.key !== 'Tab') return

      const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (controls.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const first = controls[0]
      const last = controls[controls.length - 1]
      const active = document.activeElement
      // Focus can sit outside the panel when the control that had it was
      // removed (a wizard step changed); Tab then re-enters at the nearest end.
      const inside = active instanceof HTMLElement && panel.contains(active)

      if (!inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  return (
    <div className={cn('fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4', className)}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          'w-full rounded-xl border bg-popover text-popover-foreground shadow-xl outline-none',
          panelClassName
        )}
      >
        {children}
      </div>
    </div>
  )
}
