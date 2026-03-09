import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getConsensusService, getKnowledgeService } from '@/lib/server/backbone'
import { castVoteSchema } from '../../../../../../../../../../src/backbone/validators.js'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params
  const voterId = request.headers.get('x-agent-id') || 'unknown'

  try {
    const body = await request.json()
    const parsed = castVoteSchema.parse(body)
    const consensusService = getConsensusService()
    const result = await consensusService.castVote(id, voterId, parsed)

    if (!result) {
      return NextResponse.json(
        { success: false, error: { message: 'Proposal not found', code: 'NOT_FOUND' } },
        { status: 404 }
      )
    }

    // If proposal passed and has a linked knowledge entry, auto-ratify it
    if (result.proposal.status === 'passed' && result.proposal.knowledgeEntryId) {
      const knowledgeService = getKnowledgeService()
      await knowledgeService.ratifyKnowledge(result.proposal.knowledgeEntryId)
    }

    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    const status = message.includes('already cast') || message.includes('Cannot vote') ? 409 : 400
    return NextResponse.json(
      { success: false, error: { message, code: 'VALIDATION_ERROR' } },
      { status }
    )
  }
}
