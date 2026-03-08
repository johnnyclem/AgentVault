import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: { agentId: string } }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId } = params

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    const { PolyticianMCPClient } = await import('@/orchestration/mcp-client.js')
    
    const client = new PolyticianMCPClient({
      namespace: agentId,
      entryPoint: polyticianEntry,
    })

    await client.connect()

    const statsResult = await client.callTool('get_stats', {})
    const healthResult = await client.callTool('health_check', {})

    await client.disconnect()

    const statsData = statsResult.content[0]?.data as Record<string, unknown> | undefined
    const healthData = healthResult.content[0]?.data as Record<string, unknown> | undefined

    return NextResponse.json({
      success: true,
      data: {
        agentId,
        health: {
          status: healthData?.status ?? 'unknown',
          version: healthData?.version ?? 'unknown',
        },
        stats: {
          totalConcepts: statsData?.totalConcepts ?? statsData?.concepts ?? 0,
          totalRelations: statsData?.totalRelations ?? statsData?.relations ?? 0,
          embeddingsCached: statsData?.embeddingsCached ?? statsData?.embeddings ?? 0,
          lastSync: statsData?.lastSync ?? null,
        },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'POLYTICIAN_ERROR' } },
      { status: 500 }
    )
  }
}
