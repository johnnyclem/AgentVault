'use client'

import { ExternalLink, ArrowUp, ArrowDown } from 'lucide-react'
import { Transaction } from '@/lib/types'
import { formatCycles, formatTimestamp } from '@/lib/utils'

interface TransactionHistoryProps {
  transactions: Transaction[]
  emptyMessage?: string
  onViewDetails?: (txId: string) => void
}

export function TransactionHistory({ transactions, emptyMessage = 'No transactions yet', onViewDetails }: TransactionHistoryProps) {
  return (
    <div className="surface divide-y">
      <div className="flex items-center justify-between p-4 bg-muted/50">
        <span className="font-semibold">Transaction History ({transactions.length})</span>
        <div className="flex items-center gap-2 text-sm text-primary cursor-pointer hover:underline">
          <ExternalLink className="w-4 h-4" />
          <span>View all on explorer</span>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="divide-y">
          {transactions.map((tx) => (
            <div
              key={tx.id}
              onClick={() => onViewDetails?.(tx.id)}
              className="p-4 hover:bg-muted/50 cursor-pointer transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${tx.type === 'send' ? 'bg-destructive/10' : 'bg-success/15'}`}>
                    {tx.type === 'send' ? (
                      <ArrowUp className="w-4 h-4 text-destructive" />
                    ) : (
                      <ArrowDown className="w-4 h-4 text-success" />
                    )}
                  </div>
                  <div>
                    <span className="font-medium capitalize">{tx.type}</span>
                    <p className="text-sm text-muted-foreground">
                      {formatCycles(tx.amount)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">
                    {tx.type === 'send' && tx.to ? `To: ${tx.to.slice(0, 8)}...` : ''}
                    {tx.type === 'receive' && tx.from ? `From: ${tx.from.slice(0, 8)}...` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(tx.timestamp)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
