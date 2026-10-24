'use client'

import { useState } from 'react'
import { Plus, ArrowUp, ArrowDown, Copy, Check, Wallet as WalletIcon } from 'lucide-react'
import { formatCycles, formatTimestamp } from '@/lib/utils'
import { Wallet as WalletType } from '@/lib/types'

interface WalletOverviewProps {
  wallets: WalletType[]
  onConnectWallet?: () => void
}

interface BalanceCardProps {
  wallet: WalletType
  onSend?: () => void
  onReceive?: () => void
}

export function WalletOverview({ wallets, onConnectWallet }: WalletOverviewProps) {
  const totalCycles = wallets.reduce((sum, wallet) => sum + BigInt(wallet.balance), 0n)

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-3">
        <div className="surface p-6">
          <div className="flex items-center gap-2 mb-4">
            <WalletIcon className="w-8 h-8 text-muted-foreground" />
            <span className="font-semibold">Total Balance</span>
          </div>
          <p className="text-3xl font-bold">{formatCycles(totalCycles)}</p>
          <p className="text-sm text-muted-foreground">Across all wallets</p>
        </div>

        <div className="surface p-6">
          <div className="flex items-center gap-2 mb-4">
            <Check className="w-8 h-8 text-success" />
            <span className="font-semibold">Connected Wallets</span>
          </div>
          <p className="text-sm text-muted-foreground">{wallets.length} active connections</p>
        </div>

        <div className="surface p-6">
          <div className="flex items-center gap-2 mb-4">
            <WalletIcon className="w-8 h-8 text-warning" />
            <span className="font-semibold">Status</span>
          </div>
          <p className="text-sm text-muted-foreground">All systems operational</p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onConnectWallet}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Connect New Wallet
        </button>
      </div>
    </div>
  )
}

export function BalanceCard({ wallet, onSend, onReceive }: BalanceCardProps) {
  const [copied, setCopied] = useState(false)

  const handleCopyPrincipal = () => {
    navigator.clipboard.writeText(wallet.principal)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="surface p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <WalletIcon className="w-8 h-8 text-muted-foreground" />
          <span className="font-semibold capitalize">{wallet.type} Wallet</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 bg-success/15 text-success rounded-md">
            {wallet.status === 'connected' ? 'Connected' : 'Disconnected'}
          </span>
          <button
            onClick={handleCopyPrincipal}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={copied ? 'Copied!' : 'Copy to clipboard'}
          >
            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-3xl font-bold">{formatCycles(wallet.balance)}</p>
        <p className="text-sm text-muted-foreground">Balance</p>
      </div>

      {wallet.address && (
        <div className="mb-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Address:</span>
            <span className="text-muted-foreground font-mono">{wallet.address.slice(0, 12)}...{wallet.address.slice(-4)}</span>
            <button
              onClick={handleCopyPrincipal}
              className="text-muted-foreground hover:text-foreground"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mb-4">
        Created {formatTimestamp(wallet.createdAt)}
      </p>

      <div className="pt-4 border-t flex gap-2">
        <button
          onClick={onSend}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-primary/10 text-primary rounded-lg hover:bg-primary/15 transition-colors"
        >
          <ArrowUp className="w-4 h-4" />
          Send
        </button>
        <button
          onClick={onReceive}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-success/10 text-success rounded-lg hover:bg-success/15 transition-colors"
        >
          <ArrowDown className="w-4 h-4" />
          Receive
        </button>
      </div>
    </div>
  )
}
