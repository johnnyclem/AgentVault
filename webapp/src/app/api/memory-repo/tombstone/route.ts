import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken } from '@/lib/server/auth'
import { polyticianClientError } from '@/lib/server/polytician-client'
import { memoryRepoErrorText } from '@/canister/memory-repo-actor'
import { signedMemoryRepoActor, memoryRepoWriteErrorResponse, type SignedActor } from '../signed-actor'

interface TombstoneRequest {
  branch: string
  key: string
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return polyticianClientError(401, 'UNAUTHORIZED', authResult.error ?? 'Unauthorized')
  }

  let body: TombstoneRequest
  try {
    body = await request.json()
  } catch {
    return polyticianClientError(400, 'BAD_REQUEST', 'The request body is not JSON')
  }
  if (!body?.branch || !body.key) {
    return polyticianClientError(400, 'BAD_REQUEST', 'Missing required fields: branch, key')
  }

  let signed: SignedActor | undefined
  try {
    const result = await signedMemoryRepoActor()
    if (result instanceof NextResponse) return result
    signed = result
    const { actor } = signed

    if (!(await actor.getBranches()).some(([name]) => name === body.branch)) {
      return polyticianClientError(404, 'BRANCH_NOT_FOUND', `Branch not found: ${body.branch}`)
    }

    // Onto the named branch in one call, as the commits route does: the
    // canister's current branch is shared by every writer
    const diff = JSON.stringify({ deleted: body.key })
    const commitResult = await actor.commitToBranch(body.branch, `tombstone: ${body.key}`, diff, ['tombstone'])

    if ('err' in commitResult) {
      return polyticianClientError(400, 'COMMIT_ERROR', `Tombstone commit failed: ${commitResult.err}`)
    }

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (signed) return memoryRepoWriteErrorResponse(error, signed.signer)
    return polyticianClientError(500, 'INTERNAL_ERROR', memoryRepoErrorText(error))
  }
}
