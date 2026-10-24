'use client'

import { Wallet, ArrowUp, ArrowDown, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import { formatCycles, truncatePrincipal } from '@/lib/utils'
import type { Wallet as WalletType } from '@/lib/types'

interface BalanceCardProps {
  wallet: WalletType
  onSend?: () => void
  onReceive?: () => void
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
          <Wallet className="w-5 h-5 text-muted-foreground" />
          <span className="font-semibold capitalize">{wallet.type} Wallet</span>
        </div>
        <span className="text-xs px-2 py-1 bg-success/15 text-success rounded-md">
          Connected
        </span>
      </div>

      <div className="space-y-3">
        <p className="text-2xl font-bold">{formatCycles(wallet.balance)}</p>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground font-mono flex-1 truncate">
            {truncatePrincipal(wallet.principal)}
          </span>
          <button
            onClick={handleCopyPrincipal}
            className="p-1 hover:bg-muted rounded-md transition-colors"
            title="Copy principal"
          >
            {copied ? (
              <Check className="w-4 h-4 text-success" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        </div>

        {wallet.address && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground font-mono flex-1 truncate">
              {wallet.address}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(wallet.address!)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="p-1 hover:bg-muted rounded-md transition-colors"
              title="Copy address"
            >
              {copied ? (
                <Check className="w-4 h-4 text-success" />
              ) : (
                <Copy className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Created {new Date(wallet.createdAt).toLocaleDateString()}
        </p>
      </div>

      <div className="mt-4 pt-4 border-t flex gap-2">
        <button
          onClick={onSend}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium bg-primary/10 text-primary rounded-lg hover:bg-primary/15 transition-colors"
        >
          <ArrowUp className="w-4 h-4" />
          Send
        </button>
        <button
          onClick={onReceive}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium bg-success/10 text-success rounded-lg hover:bg-success/15 transition-colors"
        >
          <ArrowDown className="w-4 h-4" />
          Receive
        </button>
      </div>
    </div>
  )
}
