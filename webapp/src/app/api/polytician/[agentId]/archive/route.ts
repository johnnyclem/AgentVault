import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'

export async function POST(
  request: NextRequest,
  { params }: { params: { agentId: string } }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId } = params

  try {
    const body = await request.json()
    const { conceptId } = body.conceptId

    if (!conceptId) {
      return NextResponse.json(
        { success: false, error: { message: 'conceptId is required', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        {
          success: false,
          error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' },
        { status: 503 }
      )
    }

    const { PolyticianMCPClient } = await import('@/orchestration/mcp-client.js')
    const client = new PolyticianMCPClient({
      namespace: 'polytician',
      entryPoint: polyticianEntry,
    })

    await client.connect()
    const result = await client.callTool('archive_concept', { id: conceptId })
    await client.disconnect()

    const archived = result.content[0]?.data ?? { txId: null }

    return NextResponse.json({ success: true, data: { archived } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
