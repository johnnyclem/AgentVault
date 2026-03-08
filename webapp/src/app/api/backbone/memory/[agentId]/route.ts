import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getMemoryService } from '@/lib/server/backbone'
import { setMemorySchema } from '../../../../../../../../../src/backbone/validators.js'

const DEFAULT_COMPANY_ID = process.env.COMPANY_ID || 'default'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { agentId } = await params
  const service = getMemoryService()
  const entries = await service.listMemory(DEFAULT_COMPANY_ID, agentId)
  return NextResponse.json({ success: true, data: entries })
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { agentId } = await params

  try {
    const body = await request.json()
    const parsed = setMemorySchema.parse(body)
    const service = getMemoryService()
    const entry = await service.setMemory(DEFAULT_COMPANY_ID, agentId, parsed)
    return NextResponse.json({ success: true, data: entry })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    return NextResponse.json(
      { success: false, error: { message, code: 'VALIDATION_ERROR' } },
      { status: 400 }
    )
  }
}
