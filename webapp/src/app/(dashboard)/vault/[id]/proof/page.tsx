'use client'

import { use } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ArweaveReceiptCard } from '@/components/proof/ArweaveReceiptCard'
import { useProof } from '@/hooks/useProof'

/*
 * An agent's evidence: its Arweave receipts, each checked in the browser.
 * The URL keeps its old /proof name because links to it already exist.
 */
export default function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { evidence, isLoading, error, refetch } = useProof(id)
  const agentHref = `/agents/${encodeURIComponent(id)}`

  return (
    <div className="page max-w-3xl">
      <div className="space-y-2">
        <BackToEvidence />
        <div className="space-y-1">
          <h1 className="page-title">Evidence</h1>
          <p className="page-subtitle">{evidence?.agentName ?? id}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex min-h-[200px] items-center justify-center gap-3 text-sm text-muted-foreground">
          <LoadingSpinner />
          Loading evidence…
        </div>
      ) : error?.code === 'AGENT_NOT_FOUND' ? (
        <p className="surface px-4 py-10 text-center text-sm text-muted-foreground">
          There is no agent called <code className="font-mono text-foreground">{id}</code>. It may have been removed, or
          the link may be wrong.
        </p>
      ) : error ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
          role="alert"
        >
          <span className="font-medium text-destructive">Couldn&apos;t load evidence.</span>
          <span className="min-w-0 break-words text-muted-foreground">{error.message}</span>
          <button
            type="button"
            onClick={refetch}
            className="ml-auto text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            Retry
          </button>
        </div>
      ) : evidence && evidence.receipts.length === 0 ? (
        <p className="surface px-4 py-10 text-center text-sm text-muted-foreground">
          No Arweave receipts for this agent yet.{' '}
          <Link href={agentHref} className="font-medium text-foreground underline-offset-4 hover:underline">
            Archive the agent
          </Link>{' '}
          to create one.
        </p>
      ) : evidence ? (
        <div className="space-y-4">
          {evidence.receipts.map((receipt) => (
            <ArweaveReceiptCard key={receipt.archiveId} receipt={receipt} />
          ))}
        </div>
      ) : null}

      {/* About a loaded agent's evidence, so not shown while loading, on an error or for an unknown agent. */}
      {evidence && !isLoading && !error && (
        <p className="text-xs text-muted-foreground">
          Not shown: signed actions and test coverage. AgentVault does not record either for an agent yet.
        </p>
      )}
    </div>
  )
}

/** Agents are listed under the Vault's Evidence filter, so that is where "back" goes. */
function BackToEvidence() {
  return (
    <Link
      href="/vault?filter=evidence"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Evidence
    </Link>
  )
}
