import { NextRequest, NextResponse } from 'next/server'
import { detectArchiveArtifacts, runArchiveWorkflow } from '@/lib/server/archive-workflow.js'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ArchiveRunBody {
  profile?: string
  sourcePath?: string
  artifactPaths?: {
    config?: string
    skill?: string
    token?: string
    soul?: string
    memory?: string
  }
  wallets?: {
    icpWalletId?: string
    arweaveWalletId?: string
    arweaveJwk?: string | Record<string, unknown>
  }
  network?: string
  mode?: 'auto' | 'install' | 'reinstall' | 'upgrade'
  canisterId?: string
  environment?: string
  identity?: string
  cycles?: string
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { id } = await context.params
    const url = new URL(request.url)

    const profile = asString(url.searchParams.get('profile')) || 'other'
    const sourcePath = asString(url.searchParams.get('sourcePath'))

    const artifactPaths = {
      config: asString(url.searchParams.get('config')),
      skill: asString(url.searchParams.get('skill')),
      token: asString(url.searchParams.get('token')),
      soul: asString(url.searchParams.get('soul')),
      memory: asString(url.searchParams.get('memory')),
    }

    const detection = detectArchiveArtifacts({
      agentId: id,
      profile,
      sourcePath,
      artifactPaths,
    })

    return NextResponse.json({
      success: true,
      data: detection,
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
    const body = await request.json() as ArchiveRunBody

    const result = await runArchiveWorkflow({
      agentId: id,
      profile: asString(body.profile) || 'other',
      sourcePath: asString(body.sourcePath),
      artifactPaths: body.artifactPaths,
      wallets: body.wallets,
      network: body.network,
      mode: body.mode,
      canisterId: body.canisterId,
      environment: body.environment,
      identity: body.identity,
      cycles: body.cycles,
    })

    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: {
          message: result.error.message,
          code: result.error.code,
          details: result.error,
        },
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      data: result.receipt,
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
