import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { invalidAgentIdResponse, withPolytician, polyticianErrorResponse } from '@/lib/server/polytician'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId } = await params
  const invalidAgentId = invalidAgentIdResponse(agentId)
  if (invalidAgentId) {
    return invalidAgentId
  }

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    const { serverInfo, stats, health } = await withPolytician(polyticianEntry, agentId, async (client, tools) => ({
      // health_check has no version; it comes from the MCP handshake
      serverInfo: client.getServerInfo(),
      stats: await tools.callPolytician(client, 'get_stats', {}),
      health: await tools.callPolytician(client, 'health_check', {}),
    }))

    return NextResponse.json({
      success: true,
      data: {
        agentId,
        // The Polytician namespace the stats are for: the agentId
        namespace: agentId,
        health: {
          status: health.server,
          version: serverInfo?.version ?? 'unknown',
          embedding: health.embedding,
          llm: health.llm,
        },
        // { conceptCount, vectorCount, representationCounts: { markdown, thoughtform, vector } }
        stats,
      },
    })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}
