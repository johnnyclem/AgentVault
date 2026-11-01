import { cn } from '@/lib/utils'

interface ErrorNoticeProps {
  /** What failed, as a sentence: "Couldn't load agents." */
  title: string
  /** The server's own message, shown after the title */
  message?: string
  onRetry?: () => void
  className?: string
}

/** One error line for every page: what failed, why, and a way to try again. */
export function ErrorNotice({ title, message, onRetry, className }: ErrorNoticeProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm',
        className
      )}
    >
      <span className="font-medium text-destructive">{title}</span>
      {message && <span className="min-w-0 break-words text-muted-foreground">{message}</span>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-auto text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  )
}
