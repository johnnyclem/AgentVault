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
  const limit = parseInt(searchParams.get('limit') ?? '50', 10)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

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
    const result = await client.callTool('list_concepts', { limit, offset })
    await client.disconnect()

    const concepts = result.content[0]?.data ?? { concepts: [], total: 0 }

    return NextResponse.json({ success: true, data: concepts })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}

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
    const result = await client.callTool('save_concept', body)
    await client.disconnect()

    const saved = result.content[0]?.data ?? { id: null, name: body.name }

    return NextResponse.json({ success: true, data: saved })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
