import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { withPolytician, polyticianErrorResponse, readJsonObject } from '@/lib/server/polytician'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { agentId } = await params
  const { searchParams } = new URL(request.url)
  const limit = searchParams.get('limit')
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0)

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
  }

    // { concepts: [{ id, namespace, version, createdAt, updatedAt, tags, representations, assertionStatus }], total }
    const concepts = await withPolytician(polyticianEntry, 'polytician', (client, tools) =>
      tools.callPolytician(client, 'list_concepts', {
        limit: tools.clampCount(limit, tools.LIST_LIMIT_MAX, 50),
        offset,
      })
    )

    return NextResponse.json({ success: true, data: concepts })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}

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

  try {
    const polyticianEntry = process.env.POLYTICIAN_ENTRY_POINT
    if (!polyticianEntry) {
      return NextResponse.json(
        { success: false, error: { message: 'Polytician entry point not configured', code: 'NOT_CONFIGURED' } },
        { status: 503 }
      )
    }

    // Polytician 3.0 concepts have no name or free-form metadata: the body is
    // { markdown, tags? } (a title goes in the markdown's first heading).
    const { markdown, tags } = (body ?? {}) as { markdown?: unknown; tags?: unknown }
    if (typeof markdown !== 'string' || !markdown.trim()) {
      return NextResponse.json(
        { success: false, error: { message: 'markdown is required', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }
    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string'))) {
      return NextResponse.json(
        { success: false, error: { message: 'tags must be an array of strings', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    const saved = await withPolytician(polyticianEntry, 'polytician', (client, tools) =>
      tools.callPolytician(client, 'save_concept', { markdown, ...(tags ? { tags: tags as string[] } : {}) })
    )

    return NextResponse.json({ success: true, data: saved })
  } catch (error) {
    return polyticianErrorResponse(error)
  }
}
