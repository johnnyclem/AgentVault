/*
 * What the agent page's archive dialog says once an archive run returns.
 * The run ends when the gateway accepts the upload, before anything is
 * mined, so this never calls the archive complete or confirmed: whether the
 * transaction was mined and holds the uploaded bytes is checked in the
 * browser on the agent's Evidence page. Kept free of imports so the root
 * test suite can load it by path.
 */

export interface ArchiveOutcome {
  title: string
  detail: string
  /** True when a transaction id came back, so there is something to check on the Evidence page */
  submitted: boolean
}

export function describeArchiveOutcome(arweave?: { transactionId?: string; skippedReason?: string }): ArchiveOutcome {
  if (arweave?.transactionId) {
    return {
      title: 'Submitted to Arweave',
      detail: 'Deployment finished. The Arweave upload was submitted; it counts as confirmed only once it is mined.',
      submitted: true,
    }
  }
  return {
    title: 'Deployment finished',
    detail: 'Deployment finished. Nothing was uploaded to Arweave.',
    submitted: false,
  }
}

/** The agent's Evidence page, which kept its /proof path so existing links still work. */
export function evidenceHref(agentId: string): string {
  return `/vault/${encodeURIComponent(agentId)}/proof`
}
