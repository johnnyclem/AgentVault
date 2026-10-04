import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { withPolytician, polyticianErrorResponse, readJsonObject } from '@/lib/server/polytician'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId } = await params

  const body = await readJsonObject(request)
  const conceptId = body?.conceptId
  if (typeof conceptId !== 'string' || !conceptId) {
    return NextResponse.json(
      { success: false, error: { message: 'conceptId is required', code: 'BAD_REQUEST' } },
      { status: 400 }
    )
  }

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        {
          success: false,
          error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' },
        },
        { status: 503 }
      )
    }

    // vault_archive_concept exists only when Polytician is configured for
    // AgentVault with archival enabled. Returns { archived, encrypted, txId, url, size }.
    // It waits up to 150 s (Polytician gives the upload 120 s); with no answer,
    // the response is 504 OUTCOME_UNKNOWN, since the paid upload may have happened.
    const outcome = await withPolytician(polyticianEntry, 'polytician', async (client, tools) => {
      try {
        return { archived: await tools.callPolytician(client, 'vault_archive_concept', { conceptId }) }
      } catch (error) {
        if (tools.isUnknownToolError(error, 'vault_archive_concept')) {
          return { notConfigured: tools.vaultToolUnavailableMessage('vault_archive_concept') }
        }
        throw error
      }
    })

    if ('notConfigured' in outcome) {
      return NextResponse.json(
        { success: false, error: { message: outcome.notConfigured, code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    return NextResponse.json({ success: true, data: outcome.archived })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}
