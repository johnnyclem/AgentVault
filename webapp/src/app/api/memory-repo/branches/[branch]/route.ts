import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { createMemoryRepoActor, createAnonymousAgent } from '@/canister/memory-repo-actor'
import { branchStateFromLog } from '@/canister/memory-repo-branch-state'

const MEMORY_REPO_CANISTER_ID = process.env.MEMORY_REPO_CANISTER_ID

async function getActor() {
  if (!MEMORY_REPO_CANISTER_ID) {
    throw new Error('MEMORY_REPO_CANISTER_ID environment variable is not set')
  }
  
  const host = process.env.ICP_LOCAL_URL || 'https://ic0.app'
  const agent = createAnonymousAgent(host)
  
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    await agent.fetchRootKey()
  }
  
  return createMemoryRepoActor(MEMORY_REPO_CANISTER_ID, agent)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ branch: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { branch } = await params

  try {
    const actor = await getActor()

    // Queries only: switchBranch is an update call, which the canister refuses
    // from the anonymous principal, and it would move the canister's current branch.
    const branches = await actor.getBranches()
    if (!branches.some(([name]) => name === branch)) {
      return NextResponse.json(
        { success: false, error: { message: `Branch '${branch}' does not exist`, code: 'BRANCH_NOT_FOUND' } },
        { status: 404 }
      )
    }

    // Every entry committed on the branch (newer commits win, tombstones
    // remove a key), not only the newest commit's: Polytician pushes one
    // commit per concept.
    const commits = await actor.log([branch])

    return NextResponse.json({ success: true, data: branchStateFromLog(branch, commits) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
