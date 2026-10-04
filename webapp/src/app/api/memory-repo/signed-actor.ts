import { NextResponse } from 'next/server'
import {
  createMemoryRepoActor,
  createMemoryRepoAgent,
  explainMemoryRepoWriteError,
  memoryRepoErrorText,
  type _SERVICE,
} from '@/canister/memory-repo-actor'
import {
  resolveServerSigningIdentity,
  SERVER_IDENTITY_GUIDANCE,
  type SigningIdentity,
} from '@/canister/identity'
import { polyticianClientError } from '@/lib/server/polytician-client'

/**
 * memory_repo refuses anonymous callers on every write, so the write routes
 * sign with the server's identity (AGENTVAULT_ICP_IDENTITY_PEM_FILE or
 * AGENTVAULT_ICP_IDENTITY_PEM), whose principal the repo owner has
 * authorized. Without one they fail closed with a 503 before calling the
 * canister. Polytician calls these routes, so every error is in the shape its
 * client reads (polyticianClientError).
 */
export interface SignedActor {
  actor: _SERVICE
  signer: SigningIdentity
}

const WRITE_ERROR_STATUS = {
  SIGNER_NOT_AUTHORIZED: 403,
  SIGNER_NOT_OWNER: 403,
  REPO_FROZEN: 423,
  REPO_KILLED: 423,
  MEMORY_REPO_OUTDATED: 502,
} as const

/** Key files already warned about, so a too-open key is logged once, not on every request. */
const warnedKeyFiles = new Set<string>()

/**
 * The memory_repo actor signed with the server's identity, or the 503 to
 * answer with when there is none or it cannot be loaded. Why a key cannot be
 * loaded goes to the server log only.
 */
export async function signedMemoryRepoActor(): Promise<SignedActor | NextResponse> {
  const canisterId = process.env.MEMORY_REPO_CANISTER_ID
  if (!canisterId) {
    throw new Error('MEMORY_REPO_CANISTER_ID environment variable is not set')
  }

  let signer: SigningIdentity | null
  try {
    signer = resolveServerSigningIdentity(process.env)
  } catch (error) {
    // Anything that stops the key loading is a configuration problem, not a
    // 500; the messages say why without key material
    console.error(`memory_repo signing identity: ${error instanceof Error ? error.message : String(error)}`)
    return polyticianClientError(
      503,
      'SIGNING_IDENTITY_INVALID',
      "The server's memory_repo signing identity could not be loaded; the server log says why."
    )
  }
  if (!signer) {
    return polyticianClientError(503, 'SIGNING_IDENTITY_NOT_CONFIGURED', SERVER_IDENTITY_GUIDANCE)
  }
  if (signer.warning && signer.source.kind === 'env-file' && !warnedKeyFiles.has(signer.source.path)) {
    warnedKeyFiles.add(signer.source.path)
    console.warn(`memory_repo signing identity: ${signer.warning}`)
  }

  const host = process.env.ICP_LOCAL_URL || 'https://ic0.app'
  const agent = await createMemoryRepoAgent(host, signer.identity)
  return { actor: createMemoryRepoActor(canisterId, agent), signer }
}

/**
 * The response for a canister call that threw: the canister's refusal of the
 * signer (403, naming the principal to authorize), of a frozen or killed repo
 * (423), or a canister built before the calls the routes make (502); else a
 * 500 with the replica's reject text.
 */
export function memoryRepoWriteErrorResponse(error: unknown, signer: SigningIdentity): NextResponse {
  const refusal = explainMemoryRepoWriteError(error, signer.principal)
  if (refusal) {
    return polyticianClientError(WRITE_ERROR_STATUS[refusal.code], refusal.code, refusal.message)
  }
  return polyticianClientError(500, 'INTERNAL_ERROR', memoryRepoErrorText(error))
}
