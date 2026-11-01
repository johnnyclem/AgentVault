'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Wallet, ArrowUp, ArrowDown } from 'lucide-react'
import { useWallets } from '@/hooks/useWallets'
import { useTransactions } from '@/hooks/useTransactions'
import { Dialog } from '@/components/common/Dialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { StatusBadge } from '@/components/common/StatusBadge'
import { formatCycles, formatTimestamp, truncatePrincipal } from '@/lib/utils'
import { describeWallet } from './wallet-card'

export default function WalletsPage() {
  const { wallets, isLoading, error } = useWallets()
  const { transactions } = useTransactions()
  const [sendModal, setSendModal] = useState<{ open: boolean; walletId: string } | null>(null)
  const [receiveModal, setReceiveModal] = useState<{ open: boolean; walletId: string } | null>(null)

  const handleSend = (walletId: string) => {
    setSendModal({ open: true, walletId })
  }

  const handleReceive = (walletId: string) => {
    setReceiveModal({ open: true, walletId })
  }

  // The modals render after .page, not inside it: its space-y margin would
  // otherwise push the fixed backdrop 24px down and leave the header undimmed.
  return (
    <>
      <div className="page">
        <div>
          <h1 className="page-title">Wallets</h1>
          <p className="page-subtitle">
            Wallets your agents hold on ICP, ckETH, Solana, Polkadot and Arweave
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center min-h-[400px]">
            <LoadingSpinner size="lg" />
          </div>
        ) : error ? (
          <ErrorNotice title="Couldn't load wallets." message={error.message} />
        ) : wallets.length === 0 ? (
          <div className="surface flex flex-col items-center justify-center p-10 text-center">
            <Wallet className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">No wallets yet</p>
            <p className="text-sm text-muted-foreground">
              Wallets are created from an agent: open it, choose Archive My Agent, then the Wallets step.
            </p>
            <Link
              href="/agents"
              className="mt-4 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Go to agents
            </Link>
          </div>
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {wallets.map((wallet) => {
                const view = describeWallet(wallet)
                return (
                  <div key={wallet.id} className="surface min-w-0 p-6">
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{view.agent ?? 'Wallet'}</p>
                        <p className="text-sm text-muted-foreground">{view.chain}</p>
                      </div>
                      {/* The list endpoint reports no connection state; claim none it did not send. */}
                      {wallet.status ? <StatusBadge status={wallet.status} className="shrink-0" /> : null}
                    </div>
                    <div className="space-y-2">
                      {view.balance !== null ? (
                        <p className="figure">{formatCycles(view.balance)}</p>
                      ) : null}
                      {view.address ? (
                        <p>
                          <span className="tag" title={view.address}>{truncatePrincipal(view.address)}</span>
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Created {formatTimestamp(wallet.createdAt)}
                      </p>
                    </div>
                    <div className="mt-4 flex gap-2 border-t pt-4">
                      <button type="button" onClick={() => handleSend(wallet.id)} className="chip text-foreground">
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                        Send
                      </button>
                      <button type="button" onClick={() => handleReceive(wallet.id)} className="chip text-foreground">
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                        Receive
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="space-y-4">
              <h2 className="text-base font-medium">Recent transactions</h2>
              {transactions.length === 0 ? (
                <div className="surface p-8 text-center text-sm text-muted-foreground">
                  <p>No transactions yet</p>
                </div>
              ) : (
                <div className="surface divide-y">
                  {transactions.slice(0, 10).map((tx) => (
                    <div key={tx.id} className="flex items-center justify-between gap-3 p-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          {tx.type === 'receive' ? <ArrowDown className="h-4 w-4" aria-hidden="true" /> : <ArrowUp className="h-4 w-4" aria-hidden="true" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium capitalize tabular-nums">{tx.type} {formatCycles(tx.amount)}</p>
                          <p className="truncate text-sm text-muted-foreground">
                            {tx.type === 'receive' ? `From ${truncatePrincipal(tx.from || '')}` : `To ${truncatePrincipal(tx.to || '')}`}
                          </p>
                        </div>
                      </div>
                      <p className="shrink-0 text-sm text-muted-foreground">{formatTimestamp(tx.timestamp)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {sendModal?.open && (
        <Dialog labelledBy="send-title" onClose={() => setSendModal(null)} panelClassName="max-w-md p-6">
          <h3 id="send-title" className="mb-4 text-lg font-medium">Send cycles</h3>
          <p className="mb-4 text-sm text-muted-foreground">Feature coming soon. Use the CLI to send cycles.</p>
          <button
            type="button"
            onClick={() => setSendModal(null)}
            className="h-9 w-full rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Close
          </button>
        </Dialog>
      )}

      {receiveModal?.open && (
        <Dialog labelledBy="receive-title" onClose={() => setReceiveModal(null)} panelClassName="max-w-md p-6">
          <h3 id="receive-title" className="mb-4 text-lg font-medium">Receive cycles</h3>
          <p className="mb-4 text-sm text-muted-foreground">Your wallet principal can receive cycles from any ICP wallet.</p>
          <button
            type="button"
            onClick={() => setReceiveModal(null)}
            className="h-9 w-full rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Close
          </button>
        </Dialog>
      )}
    </>
  )
}
