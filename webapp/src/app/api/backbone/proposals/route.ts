import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getConsensusService } from '@/lib/server/backbone'
import { createProposalSchema } from '../../../../../../../../src/backbone/validators.js'
import type { ProposalStatus } from '../../../../../../../../src/backbone/constants.js'

const DEFAULT_COMPANY_ID = process.env.COMPANY_ID || 'default'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') as ProposalStatus | null

  const service = getConsensusService()
  const proposals = await service.listProposals(
    DEFAULT_COMPANY_ID,
    status ?? undefined,
  )

  return NextResponse.json({ success: true, data: proposals })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  try {
    const body = await request.json()
    const parsed = createProposalSchema.parse(body)
    const createdBy = request.headers.get('x-agent-id') || 'unknown'
    const service = getConsensusService()
    const proposal = await service.createProposal(DEFAULT_COMPANY_ID, createdBy, parsed)
    return NextResponse.json({ success: true, data: proposal }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    return NextResponse.json(
      { success: false, error: { message, code: 'VALIDATION_ERROR' } },
      { status: 400 }
    )
  }
}
