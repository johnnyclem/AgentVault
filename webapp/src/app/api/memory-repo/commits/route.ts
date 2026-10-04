import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken } from '@/lib/server/auth'
import { polyticianClientError } from '@/lib/server/polytician-client'
import { memoryRepoErrorText } from '@/canister/memory-repo-actor'
import { signedMemoryRepoActor, memoryRepoWriteErrorResponse, type SignedActor } from '../signed-actor'

interface CommitRequest {
  branch: string
  message: string
  entries: Array<{
    key: string
    data: string
    tags?: string[]
  }>
}

interface CommitResponse {
  sha: string
  branch: string
  author: string
  timestamp: string
  message: string
  entries: Array<{ key: string }>
}

/** The branch a new branch forks from: the one initRepo creates. */
const ROOT_BRANCH = 'main'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return polyticianClientError(401, 'UNAUTHORIZED', authResult.error ?? 'Unauthorized')
  }

  let body: CommitRequest
  try {
    body = await request.json()
  } catch {
    return polyticianClientError(400, 'BAD_REQUEST', 'The request body is not JSON')
  }
  if (!body?.branch || !body.message || !Array.isArray(body.entries)) {
    return polyticianClientError(400, 'BAD_REQUEST', 'Missing required fields: branch, message, entries')
  }

  let signed: SignedActor | undefined
  try {
    const result = await signedMemoryRepoActor()
    if (result instanceof NextResponse) return result
    signed = result
    const { actor, signer } = signed

    // Every call names the branch. The canister's current branch is shared by
    // every writer (concurrent pushes, `agentvault memory checkout`), so
    // switching to the branch and then committing could land the commit on a
    // branch another writer switched to in between.
    const branchExists = async () => (await actor.getBranches()).some(([name]) => name === body.branch)
    if (!(await branchExists())) {
      // From main, not the current branch, so a new sync branch does not
      // start with another branch's entries
      const created = await actor.createBranchFrom(body.branch, ROOT_BRANCH)
      // "already exists" when another push created it in the meantime
      if ('err' in created && !(await branchExists())) {
        return polyticianClientError(400, 'BRANCH_ERROR', `Failed to create branch: ${created.err}`)
      }
    }

    const diff = JSON.stringify(body.entries)
    const tags = body.entries.flatMap(e => e.tags ?? [])

    const commitResult = await actor.commitToBranch(body.branch, body.message, diff, tags)

    if ('err' in commitResult) {
      return polyticianClientError(400, 'COMMIT_ERROR', `Commit failed: ${commitResult.err}`)
    }

    const sha = commitResult.ok
    const [recorded] = await actor.getCommit(sha)

    const response: CommitResponse = {
      sha,
      branch: body.branch,
      // The canister records no author; the commit was signed by this principal.
      author: signer.principal,
      timestamp: recorded ? new Date(Number(recorded.timestamp / 1_000_000n)).toISOString() : new Date().toISOString(),
      message: body.message,
      entries: body.entries.map(e => ({ key: e.key })),
    }

    return NextResponse.json({ success: true, data: response })
  } catch (error) {
    if (signed) return memoryRepoWriteErrorResponse(error, signed.signer)
    return polyticianClientError(500, 'INTERNAL_ERROR', memoryRepoErrorText(error))
  }
}
