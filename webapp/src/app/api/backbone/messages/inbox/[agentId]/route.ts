import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getCommunicationService } from '@/lib/server/backbone'

const DEFAULT_COMPANY_ID = process.env.COMPANY_ID || 'default'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { agentId } = await params
  const service = getCommunicationService()
  const messages = await service.getInbox(DEFAULT_COMPANY_ID, agentId)
  return NextResponse.json({ success: true, data: messages })
}
