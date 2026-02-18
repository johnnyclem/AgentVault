import { NextRequest, NextResponse } from 'next/server'
import { listAgentWallets } from '@/wallet/wallet-manager.js'
import { getWallet } from '@/wallet/wallet-manager.js'
import { listAgents } from '@/wallet/wallet-storage.js'

interface WalletSummary {
  id: string
  agentId: string
  chain: string
  address: string
  principal: string
  type: 'local' | 'hardware'
  balance?: string
  createdAt: string
}

function toWalletSummary(agentId: string, walletId: string): WalletSummary | null {
  const wallet = getWallet(agentId, walletId)
  if (!wallet) {
    return null
  }

  return {
    id: wallet.id,
    agentId: wallet.agentId,
    chain: wallet.chain,
    address: wallet.address,
    principal: wallet.address,
    type: 'local',
    createdAt: new Date(wallet.createdAt).toISOString(),
  }
}

export async function GET(request: NextRequest) {
  try {
    const query = new URL(request.url)
    const chainFilter = query.searchParams.get('chain')

    const agentIds = listAgents()
    const summaries: WalletSummary[] = []

    for (const agentId of agentIds) {
      const walletIds = listAgentWallets(agentId)
      const filtered = walletIds
        .map((walletId) => toWalletSummary(agentId, walletId))
        .filter((wallet): wallet is WalletSummary => Boolean(wallet))

      if (chainFilter) {
        summaries.push(...filtered.filter((wallet) => wallet.chain === chainFilter))
      } else {
        summaries.push(...filtered)
      }
    }

    return NextResponse.json({ success: true, data: summaries })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
