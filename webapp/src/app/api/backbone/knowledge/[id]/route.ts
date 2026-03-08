import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getKnowledgeService } from '@/lib/server/backbone'
import { updateKnowledgeEntrySchema } from '../../../../../../../../../src/backbone/validators.js'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params
  const service = getKnowledgeService()
  const entry = await service.getKnowledge(id)

  if (!entry) {
    return NextResponse.json(
      { success: false, error: { message: 'Knowledge entry not found', code: 'NOT_FOUND' } },
      { status: 404 }
    )
  }

  return NextResponse.json({ success: true, data: entry })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params

  try {
    const body = await request.json()
    const parsed = updateKnowledgeEntrySchema.parse(body)
    const updatedBy = request.headers.get('x-agent-id') || 'unknown'
    const service = getKnowledgeService()
    const entry = await service.updateKnowledge(id, updatedBy, parsed)

    if (!entry) {
      return NextResponse.json(
        { success: false, error: { message: 'Knowledge entry not found', code: 'NOT_FOUND' } },
        { status: 404 }
      )
    }

    return NextResponse.json({ success: true, data: entry })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    return NextResponse.json(
      { success: false, error: { message, code: 'VALIDATION_ERROR' } },
      { status: 400 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params
  const service = getKnowledgeService()
  const deleted = await service.deleteKnowledge(id)

  if (!deleted) {
    return NextResponse.json(
      { success: false, error: { message: 'Knowledge entry not found', code: 'NOT_FOUND' } },
      { status: 404 }
    )
  }

  return NextResponse.json({ success: true })
}
