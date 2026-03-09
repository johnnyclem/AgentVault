import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: { agentId: string; id: string } }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId, id } = params

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
    const result = await client.callTool('read_concept', { id })
    await client.disconnect()

    const concept = result.content[0]?.data

    if (!concept) {
      return NextResponse.json(
        { success: false, error: { message: 'Concept not found', code: 'NOT_FOUND' } },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true, data: concept })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { agentId: string; id: string } }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId, id } = params

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
    const result = await client.callTool('delete_concept', { id })
    await client.disconnect()

    const deleted = result.content[0]?.data ?? { id }

    return NextResponse.json({ success: true, data: deleted })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
