import { NextRequest, NextResponse } from 'next/server'
import { createWalletForAgent, listWalletSummaries } from '@/lib/server/archive-workflow.js'
import type { WalletData } from '@/wallet/types.js'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface CreateWalletBody {
  chain?: string
  method?: 'generate' | 'import-seed' | 'import-private-key'
  value?: string
  derivationPath?: string
  arweaveJwk?: string | Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseJwk(raw?: string | Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
    } catch (_error) {
      return undefined
    }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  return raw
}

function sanitizeWallet(wallet: WalletData): {
  id: string
  agentId: string
  chain: string
  address: string
  method: string
  hasJwk?: boolean
  updatedAt: string
  createdAt: string
} {
  const chainMetadata = (wallet.chainMetadata ?? {}) as Record<string, unknown>

  return {
    id: wallet.id,
    agentId: wallet.agentId,
    chain: wallet.chain,
    address: wallet.address,
    method: wallet.creationMethod,
    hasJwk: Boolean(chainMetadata?.jwk),
    updatedAt: new Date(wallet.updatedAt).toISOString(),
    createdAt: new Date(wallet.createdAt).toISOString(),
  }
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id } = await context.params
    const url = new URL(request.url)
    const chain = asString(url.searchParams.get('chain'))

    const wallets = listWalletSummaries(id).filter((wallet) => {
      if (!chain) {
        return true
      }

      return wallet.chain === chain
    })

    return NextResponse.json({
      success: true,
      data: wallets.map(sanitizeWallet),
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id } = await context.params
    const body = await request.json() as CreateWalletBody

    const chain = asString(body.chain) as 'icp' | 'arweave' | undefined
    const method = body.method

    if (!chain || !['icp', 'arweave'].includes(chain)) {
      return NextResponse.json({
        success: false,
        error: {
          message: 'chain must be icp or arweave',
        },
      }, { status: 400 })
    }

    if (method !== 'generate' && method !== 'import-seed' && method !== 'import-private-key') {
      return NextResponse.json({
        success: false,
        error: {
          message: 'method must be generate, import-seed, or import-private-key',
        },
      }, { status: 400 })
    }

    const value = asString(body.value)
    const derivationPath = asString(body.derivationPath)
    const chainMetadata = chain === 'arweave'
      ? parseJwk(body.arweaveJwk)
      : undefined

    const result = await createWalletForAgent(
      id,
      chain,
      method,
      value,
      derivationPath,
      chainMetadata
        ? {
            jwk: chainMetadata,
          }
        : undefined,
    )

    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: {
          message: result.error,
        },
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      data: sanitizeWallet(result.wallet),
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    }, { status: 500 })
  }
}
