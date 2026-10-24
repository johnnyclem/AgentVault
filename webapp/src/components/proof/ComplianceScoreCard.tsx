'use client'

import { TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComplianceScore } from '@/lib/types'

interface ComplianceScoreCardProps {
  compliance: ComplianceScore
}

function ScoreSegment({
  label,
  value,
  contribution,
  weight,
}: {
  label: string
  value: number
  contribution: number
  weight: number
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-muted-foreground truncate">
            {label}
            <span className="ml-1 tabular-nums">×{(weight * 100).toFixed(0)}%</span>
          </span>
          <span className="font-mono font-semibold ml-2">{value.toFixed(0)}%</span>
        </div>
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-700"
            style={{ width: `${value}%` }}
          />
        </div>
      </div>
      <span className="text-xs font-mono text-muted-foreground w-7 text-right shrink-0">
        +{contribution}
      </span>
    </div>
  )
}

export function ComplianceScoreCard({ compliance }: ComplianceScoreCardProps) {
  const { score, grade, meetsStandard, standardThreshold, details, coverageWeight, vetKeyWeight, arweaveWeight } = compliance

  const gradeColor = {
    A: 'text-success',
    B: 'text-primary',
    C: 'text-warning',
    D: 'text-warning',
    F: 'text-destructive',
  }[grade]

  const ringColor = meetsStandard
    ? 'stroke-success'
    : score >= 60
    ? 'stroke-warning'
    : 'stroke-destructive'

  // SVG ring math
  const r = 38
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ

  return (
    <div className="surface p-5 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">Compliance Score</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Weighted composite · CTO standard {standardThreshold}%
          </p>
        </div>
        <TrendingUp className="w-5 h-5 text-muted-foreground" />
      </div>

      {/* Donut + grade */}
      <div className="flex items-center gap-6">
        <div className="relative w-24 h-24 shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r={r} fill="none" className="stroke-muted" strokeWidth="10" />
            <circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              className={ringColor}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ}`}
              style={{ transition: 'stroke-dasharray 0.8s ease' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold tabular-nums">{score}</span>
            <span className="text-xs text-muted-foreground">/ 100</span>
          </div>
        </div>

        <div className="flex-1 space-y-1.5">
          <div className="flex items-baseline gap-2">
            <span className={cn('text-5xl font-bold', gradeColor)}>{grade}</span>
            <span className="text-sm text-muted-foreground">
              {meetsStandard ? '✓ Compliant' : '✗ Below threshold'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {meetsStandard
              ? `${score - standardThreshold}% above minimum requirement`
              : `${standardThreshold - score}% below minimum requirement`}
          </p>
        </div>
      </div>

      {/* Score breakdown */}
      <div className="space-y-3 pt-3 border-t border-border">
        <p className="text-xs font-medium text-muted-foreground">Breakdown</p>
        <ScoreSegment
          label="Test Coverage"
          value={compliance.details.coverageContribution / coverageWeight}
          contribution={details.coverageContribution}
          weight={coverageWeight}
        />
        <ScoreSegment
          label="VetKey Signatures"
          value={compliance.details.vetKeyContribution / vetKeyWeight}
          contribution={details.vetKeyContribution}
          weight={vetKeyWeight}
        />
        <ScoreSegment
          label="Arweave Anchor"
          value={compliance.details.arweaveContribution / arweaveWeight}
          contribution={details.arweaveContribution}
          weight={arweaveWeight}
        />
      </div>
    </div>
  )
}
