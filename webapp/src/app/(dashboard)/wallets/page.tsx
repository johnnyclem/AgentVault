'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Wallet, ArrowUp, ArrowDown } from 'lucide-react'
import { useWallets } from '@/hooks/useWallets'
import { useTransactions } from '@/hooks/useTransactions'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
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
          <div className="flex items-center justify-center min-h-[400px]">
            <p className="text-sm text-destructive">{error.message}</p>
          </div>
        ) : wallets.length === 0 ? (
          <div className="surface flex flex-col items-center justify-center p-10 text-center">
            <Wallet className="w-10 h-10 mb-3 text-muted-foreground" />
            <p className="font-medium">No wallets yet</p>
            <p className="text-sm text-muted-foreground">
              Wallets are created from an agent: open it, choose Archive My Agent, then the Wallets step.
            </p>
            <Link
              href="/agents"
              className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Go to Agents
            </Link>
          </div>
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {wallets.map((wallet) => {
                const view = describeWallet(wallet)
                return (
                  <div key={wallet.id} className="surface p-6">
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Wallet className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{view.agent ?? 'Wallet'}</p>
                          <p className="text-sm text-muted-foreground">{view.chain}</p>
                        </div>
                      </div>
                      {/* The list endpoint reports no connection state; claim none it did not send. */}
                      {wallet.status ? (
                        <span className={`shrink-0 rounded px-2 py-1 text-xs capitalize ${
                          wallet.status === 'connected'
                            ? 'bg-success/15 text-success'
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {wallet.status}
                        </span>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      {view.balance !== null ? (
                        <p className="text-2xl font-bold">{formatCycles(view.balance)}</p>
                      ) : null}
                      {view.address ? (
                        <p className="truncate font-mono text-sm text-muted-foreground" title={view.address}>
                          {truncatePrincipal(view.address)}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Created {formatTimestamp(wallet.createdAt)}
                      </p>
                    </div>
                    <div className="mt-4 pt-4 border-t flex gap-2">
                      <button 
                        onClick={() => handleSend(wallet.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary/10 text-primary rounded-lg hover:bg-primary/15 transition-colors"
                      >
                        <ArrowUp className="w-4 h-4" />
                        Send
                      </button>
                      <button 
                        onClick={() => handleReceive(wallet.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-success/10 text-success rounded-lg hover:bg-success/15 transition-colors"
                      >
                        <ArrowDown className="w-4 h-4" />
                        Receive
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Recent Transactions</h2>
              {transactions.length === 0 ? (
                <div className="surface p-8 text-center text-sm text-muted-foreground">
                  <p>No transactions yet</p>
                </div>
              ) : (
                <div className="surface divide-y">
                  {transactions.slice(0, 10).map((tx) => (
                    <div key={tx.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${tx.type === 'receive' ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive'}`}>
                          {tx.type === 'receive' ? <ArrowDown className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
                        </div>
                        <div>
                          <p className="font-medium capitalize">{tx.type} {formatCycles(tx.amount)}</p>
                          <p className="text-sm text-muted-foreground">
                            {tx.type === 'receive' ? `From ${truncatePrincipal(tx.from || '')}` : `To ${truncatePrincipal(tx.to || '')}`}
                          </p>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">{formatTimestamp(tx.timestamp)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {sendModal?.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="rounded-xl border bg-popover text-popover-foreground p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Send Cycles</h3>
            <p className="text-sm text-muted-foreground mb-4">Feature coming soon. Use the CLI to send cycles.</p>
            <button 
              onClick={() => setSendModal(null)}
              className="w-full px-4 py-2 text-sm font-medium border rounded-lg hover:bg-muted transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {receiveModal?.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="rounded-xl border bg-popover text-popover-foreground p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Receive Cycles</h3>
            <p className="text-sm text-muted-foreground mb-4">Your wallet principal can receive cycles from any ICP wallet.</p>
            <button 
              onClick={() => setReceiveModal(null)}
              className="w-full px-4 py-2 text-sm font-medium border rounded-lg hover:bg-muted transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
