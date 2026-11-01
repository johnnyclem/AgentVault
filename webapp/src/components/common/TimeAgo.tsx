'use client'

import { useEffect, useState } from 'react'
import { formatTimestamp } from '@/lib/utils'
import { cn } from '@/lib/utils'

interface TimeAgoProps {
  timestamp: string
  className?: string
}

export function TimeAgo({ timestamp, className }: TimeAgoProps) {
  const [relativeTime, setRelativeTime] = useState(formatTimestamp(timestamp))

  useEffect(() => {
    const interval = setInterval(() => {
      setRelativeTime(formatTimestamp(timestamp))
    }, 60_000)

    return () => clearInterval(interval)
  }, [timestamp])

  return (
    <time className={cn('text-sm tabular-nums text-muted-foreground', className)} dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
      {relativeTime}
    </time>
  )
}
