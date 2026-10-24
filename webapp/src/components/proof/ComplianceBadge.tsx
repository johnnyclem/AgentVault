'use client'

import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComplianceScore } from '@/lib/types'

interface ComplianceBadgeProps {
  compliance: ComplianceScore
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function ComplianceBadge({ compliance, size = 'md', className }: ComplianceBadgeProps) {
  const { score, grade, meetsStandard, standardThreshold } = compliance

  const colorClass = meetsStandard
    ? 'text-success border-success/30 bg-success/10'
    : score >= 60
    ? 'text-warning border-warning/30 bg-warning/10'
    : 'text-destructive border-destructive/30 bg-destructive/10'

  const Icon = meetsStandard ? ShieldCheck : score >= 60 ? ShieldAlert : ShieldX

  const sizeClass = {
    sm: 'px-2.5 py-1 text-xs gap-1.5',
    md: 'px-4 py-2 text-sm gap-2',
    lg: 'px-6 py-3 text-base gap-2.5',
  }[size]

  const iconSize = { sm: 'w-3.5 h-3.5', md: 'w-4 h-4', lg: 'w-5 h-5' }[size]

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-semibold',
        colorClass,
        sizeClass,
        className
      )}
    >
      <Icon className={iconSize} />
      <span>{score}%</span>
      <span aria-hidden="true">·</span>
      <span>Grade {grade}</span>
      {meetsStandard ? (
        <span className="font-normal">meets CTO {standardThreshold}% rule</span>
      ) : (
        <span className="font-normal">below {standardThreshold}% threshold</span>
      )}
    </span>
  )
}
