import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getKnowledgeService } from '@/lib/server/backbone'
import { createKnowledgeEntrySchema } from '../../../../../../../../src/backbone/validators.js'
import type { KnowledgeCategory, KnowledgeStatus } from '../../../../../../../../src/backbone/constants.js'

const DEFAULT_COMPANY_ID = process.env.COMPANY_ID || 'default'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category') as KnowledgeCategory | null
  const status = searchParams.get('status') as KnowledgeStatus | null
  const search = searchParams.get('search')

  const service = getKnowledgeService()
  const entries = await service.listKnowledge(DEFAULT_COMPANY_ID, {
    category: category ?? undefined,
    status: status ?? undefined,
    search: search ?? undefined,
  })

  return NextResponse.json({ success: true, data: entries })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  try {
    const body = await request.json()
    const parsed = createKnowledgeEntrySchema.parse(body)
    const createdBy = request.headers.get('x-agent-id') || 'unknown'
    const service = getKnowledgeService()
    const entry = await service.createKnowledge(DEFAULT_COMPANY_ID, createdBy, parsed)
    return NextResponse.json({ success: true, data: entry }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    return NextResponse.json(
      { success: false, error: { message, code: 'VALIDATION_ERROR' } },
      { status: 400 }
    )
  }
}
