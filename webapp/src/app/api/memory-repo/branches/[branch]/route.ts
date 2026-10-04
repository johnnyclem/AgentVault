import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken } from '@/lib/server/auth'
import { polyticianClientError } from '@/lib/server/polytician-client'
import { createMemoryRepoActor, createMemoryRepoAgent, memoryRepoErrorText } from '@/canister/memory-repo-actor'
import { branchStateFromLog } from '@/canister/memory-repo-branch-state'

/** An anonymous actor: this route only queries, which the canister allows anyone. */
async function getActor() {
  const canisterId = process.env.MEMORY_REPO_CANISTER_ID
  if (!canisterId) {
    throw new Error('MEMORY_REPO_CANISTER_ID environment variable is not set')
  }

  const agent = await createMemoryRepoAgent(process.env.ICP_LOCAL_URL || 'https://ic0.app')
  return createMemoryRepoActor(canisterId, agent)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ branch: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return polyticianClientError(401, 'UNAUTHORIZED', authResult.error ?? 'Unauthorized')
  }

  const { branch } = await params

  try {
    const actor = await getActor()

    // Queries only: switchBranch is an update call, which the canister refuses
    // from the anonymous principal, and it would move the canister's current branch.
    const branches = await actor.getBranches()
    if (!branches.some(([name]) => name === branch)) {
      return polyticianClientError(404, 'BRANCH_NOT_FOUND', `Branch '${branch}' does not exist`)
    }

    // Every entry committed on the branch (newer commits win, tombstones
    // remove a key), not only the newest commit's: Polytician pushes one
    // commit per concept.
    const commits = await actor.log([branch])

    return NextResponse.json({ success: true, data: branchStateFromLog(branch, commits) })
  } catch (error) {
    return polyticianClientError(500, 'INTERNAL_ERROR', memoryRepoErrorText(error))
  }
}
