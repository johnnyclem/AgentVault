import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { getConsensusService } from '@/lib/server/backbone'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) return unauthorizedResponse(authResult.error ?? 'Unauthorized')

  const { id } = await params
  const service = getConsensusService()
  const proposal = await service.vetoProposal(id)

  if (!proposal) {
    return NextResponse.json(
      { success: false, error: { message: 'Proposal not found or cannot be vetoed', code: 'NOT_FOUND' } },
      { status: 404 }
    )
  }

  return NextResponse.json({ success: true, data: proposal })
}
