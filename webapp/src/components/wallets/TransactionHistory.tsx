'use client'

import { ExternalLink, Trash2, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react'
import { Wallet as WalletType, Transaction } from '@/lib/types'
import { formatCycles, formatTimestamp } from '@/lib/utils'

interface TransactionHistoryProps {
  transactions: Transaction[]
  emptyMessage?: string
  onViewDetails?: (txId: string) => void
}

interface TransactionProps {
  tx: Transaction
}

export function TransactionHistory({ transactions, emptyMessage = 'No transactions yet', onViewDetails }: TransactionHistoryProps) {
  return (
    <div className="border rounded-lg divide-y">
      <div className="flex items-center justify-between p-4 bg-gray-50">
        <span className="font-semibold">Transaction History ({transactions.length})</span>
        <ExternalLink className="w-4 h-4 text-blue-500" />
        <span className="text-sm text-gray-600">View all on blockchain explorer</span>
      </div>
      </div>

      {transactions.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {emptyMessage}
        </div>
      ) : (
        <div className="divide-y">
          {transactions.map((tx) => (
            <div
              key={tx.id}
              onClick={() => onViewDetails(tx.id)}
              className="p-4 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              <div className="flex items-start gap-4">
                <div className="flex items-center gap-3">
                  {tx.type === 'send' ? (
                    <ArrowUp className="w-4 h-4 text-red-500" />
                  ) : (
                    <ArrowDown className="w-4 h-4 text-green-500" />
                  )}
                  <span className="font-medium capitalize">{tx.type} {formatCycles(tx.amount)}</span>
                </div>
                <div>
                  <p className="text-sm text-gray-600">
                    {tx.type === 'send' ? `To: ${tx.to?.slice(0, 8)}...` : `From: ${tx.from?.slice(0, 8)}...`}
                  </p>
                  <p className="text-xs text-gray-600">
                    {formatTimestamp(tx.timestamp)}
                  </p>
                </div>
              </div>
              <div className="ml-auto text-right">
                <ExternalLink className="w-4 h-4 text-blue-500" />
                <span className="text-xs text-blue-600 hover:underline">{formatTimestamp(tx.timestamp)} →</span>
              </div>
            </div>
          </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Transaction({ tx }: TransactionProps) {
  const typeColors = {
    send: 'bg-red-50 text-red-600',
    receive: 'bg-green-100 text-green-600',
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <div className={`w-6 h-6 rounded-full ${typeColors[tx.type as keyof typeof typeColors] || typeColors.receive}`}>
        {tx.type === 'send' ? (
          <ArrowUp className="w-4 h-4 text-red-500" />
        ) : (
          <ArrowDown className="w-4 h-4 text-green-500" />
        )}
      </div>
    </div>
      <span className="text-sm font-gray-600 capitalize">{tx.type}</span>
    </div>
  )
}
