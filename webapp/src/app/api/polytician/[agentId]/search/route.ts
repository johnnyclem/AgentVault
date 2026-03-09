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
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q') ?? searchParams.get('query') ?? ''
  const limit = parseInt(searchParams.get('limit') ?? '10', 10)

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

    const { PolyticianMCPClient } = await import('@/orchestration/mcp-client.js')
    const client = new PolyticianMCPClient({
      namespace: 'polytician',
      entryPoint: polyticianEntry,
    })

    await client.connect()
    const result = await client.callTool('search_concepts', {
      query,
      limit,
    })
    await client.disconnect()

    const concepts = result.content[0]?.data ?? { concepts: [] }

    return NextResponse.json({ success: true, data: concepts })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
