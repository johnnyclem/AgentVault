import type { Wallet } from '@/lib/types'

/*
 * What each card on /wallets shows. GET /api/wallets reports a wallet's id,
 * owning agent, chain and address, but no balance, so a card leads with the
 * agent and chain (the pair a /vault wallet row shows, so a user who clicked
 * that row can find the same wallet here) and leaves the balance out instead
 * of printing "NaN T". Imports from '@/' stay type-only: the root test suite
 * loads this file directly and cannot resolve the webapp's aliases at runtime.
 */

const CHAIN_LABELS: Record<string, string> = {
  icp: 'ICP',
  cketh: 'ckETH',
  solana: 'Solana',
  polkadot: 'Polkadot',
  arweave: 'Arweave',
}

export interface WalletCardView {
  /** 'ICP', 'Solana' and so on; an unknown chain is shown as reported, a missing one as 'Wallet' */
  chain: string
  /** The agent the wallet belongs to, when the API names one */
  agent: string | null
  /** The full address (the principal for older records); the page shortens it for display */
  address: string | null
  /** Set only when the API reported a balance that is a real number */
  balance: number | null
}

/**
 * The type says balance is always there, but the list endpoint never sends it
 * (and a future one may send a numeric string), so anything that does not
 * come out as a finite number counts as unknown.
 */
function knownBalance(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function describeWallet(wallet: Wallet): WalletCardView {
  const chain = wallet.chain?.trim()

  return {
    chain: chain ? (CHAIN_LABELS[chain.toLowerCase()] ?? chain) : 'Wallet',
    agent: wallet.agentId?.trim() || null,
    address: wallet.address || wallet.principal || null,
    balance: knownBalance(wallet.balance),
  }
}
