import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getMemoryService } from '@/lib/server/backbone'

const DEFAULT_COMPANY_ID = process.env.COMPANY_ID || 'default'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string; key: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { agentId, key } = await params
  const service = getMemoryService()
  const entry = await service.getMemory(DEFAULT_COMPANY_ID, agentId, key)

  if (!entry) {
    return NextResponse.json(
      { success: false, error: { message: `Memory key "${key}" not found`, code: 'NOT_FOUND' } },
      { status: 404 }
    )
  }

  return NextResponse.json({ success: true, data: entry })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string; key: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { agentId, key } = await params
  const service = getMemoryService()
  const deleted = await service.deleteMemory(DEFAULT_COMPANY_ID, agentId, key)

  if (!deleted) {
    return NextResponse.json(
      { success: false, error: { message: `Memory key "${key}" not found`, code: 'NOT_FOUND' } },
      { status: 404 }
    )
  }

  return NextResponse.json({ success: true })
}
