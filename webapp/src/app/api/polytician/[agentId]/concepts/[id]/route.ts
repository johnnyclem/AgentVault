import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { withPolytician, polyticianErrorResponse } from '@/lib/server/polytician'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string; id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId, id } = await params

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    // An unknown id is Polytician's NOT_FOUND (404); a malformed one, VALIDATION_ERROR (400)
    const concept = await withPolytician(polyticianEntry, 'polytician', (client, tools) =>
      tools.callPolytician(client, 'read_concept', { id })
    )

    return NextResponse.json({ success: true, data: concept })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string; id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId, id } = await params

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    const deleted = await withPolytician(polyticianEntry, 'polytician', (client, tools) =>
      tools.callPolytician(client, 'delete_concept', { id })
    )

    return NextResponse.json({ success: true, data: deleted })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}
