import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getCommunicationService } from '@/lib/server/backbone'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params
  const service = getCommunicationService()
  const message = await service.acknowledgeMessage(id)

  if (!message) {
    return NextResponse.json(
      { success: false, error: { message: 'Message not found', code: 'NOT_FOUND' } },
      { status: 404 }
    )
  }

  return NextResponse.json({ success: true, data: message })
}
