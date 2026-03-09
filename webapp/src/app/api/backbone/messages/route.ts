import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getCommunicationService } from '@/lib/server/backbone'
import { sendMessageSchema } from '../../../../../../../../src/backbone/validators.js'

const DEFAULT_COMPANY_ID = process.env.COMPANY_ID || 'default'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const fromAgentId = request.headers.get('x-agent-id')
  if (!fromAgentId) {
    return NextResponse.json(
      { success: false, error: { message: 'x-agent-id header is required', code: 'VALIDATION_ERROR' } },
      { status: 400 }
    )
  }

  try {
    const body = await request.json()
    const parsed = sendMessageSchema.parse(body)
    const service = getCommunicationService()
    const message = await service.sendMessage(DEFAULT_COMPANY_ID, fromAgentId, parsed)
    return NextResponse.json({ success: true, data: message }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    return NextResponse.json(
      { success: false, error: { message, code: 'VALIDATION_ERROR' } },
      { status: 400 }
    )
  }
}
