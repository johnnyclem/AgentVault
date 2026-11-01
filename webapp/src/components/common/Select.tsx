import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Classes for the wrapper, which takes the width */
  wrapperClassName?: string
}

/**
 * A native select drawn like the text inputs around it: the same 36px height,
 * 10px radius and focus ring, with the page's own chevron in place of the
 * operating system's. It stays a real select, so the keyboard, the picker on
 * phones and screen readers behave as usual.
 */
export function Select({ className, wrapperClassName, children, ...props }: SelectProps) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <select
        {...props}
        className={cn(
          'h-9 w-full appearance-none rounded-lg border bg-background pl-3 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  )
}
