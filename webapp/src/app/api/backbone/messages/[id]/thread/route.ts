import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getCommunicationService } from '@/lib/server/backbone'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params
  const service = getCommunicationService()
  const messages = await service.getThread(id)
  return NextResponse.json({ success: true, data: messages })
}
