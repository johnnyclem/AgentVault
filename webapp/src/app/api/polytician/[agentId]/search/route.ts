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
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q') ?? searchParams.get('query') ?? ''
  const limit = searchParams.get('limit')

  if (!query.trim()) {
    return NextResponse.json(
      { success: false, error: { message: 'Query parameter required', code: 'BAD_REQUEST' } },
      { status: 400 }
    )
  }

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    // ?limit= becomes search_concepts' k (1-100, default 10). Results are
    // { id, namespace, score, tags, representations, assertionStatus }, best first.
    const { results } = await withPolytician(polyticianEntry, agentId, (client, tools) =>
      tools.callPolytician(client, 'search_concepts', {
        query: query.slice(0, tools.MAX_QUERY_LENGTH),
        k: tools.clampCount(limit, tools.SEARCH_K_MAX, 10),
      })
    )

    return NextResponse.json({ success: true, data: { results } })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}
