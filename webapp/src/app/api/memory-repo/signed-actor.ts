import { NextResponse } from 'next/server'
import {
  createMemoryRepoActor,
  createMemoryRepoAgent,
  explainMemoryRepoWriteError,
  memoryRepoErrorText,
  type OperationResult,
  type _SERVICE,
} from '@/canister/memory-repo-actor'
import {
  resolveServerSigningIdentity,
  SERVER_IDENTITY_GUIDANCE,
  type SigningIdentity,
} from '@/canister/identity'
import { callWithReceipt, recordCalls, type ReceiptContext, type ReceiptedCall } from '@/canister/memory-repo-receipts'
import { appendIcpWriteReceipt } from '@/lib/server/memory-write-receipts'
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
  /** For queries; writes go through commitToBranch and createBranchFrom below */
  actor: _SERVICE
  signer: SigningIdentity
  /**
   * actor.commitToBranch, with a receipt kept when the canister replies {ok}.
   * Same result and same errors as the plain call: capture never fails,
   * retries or changes the write.
   */
  commitToBranch(kind: 'commit' | 'tombstone', branch: string, message: string, diff: string, tags: string[]): Promise<OperationResult>
  /** actor.createBranchFrom, with a receipt kept the same way */
  createBranchFrom(name: string, base: string): Promise<OperationResult>
}

const WRITE_ERROR_STATUS = {
  SIGNER_NOT_AUTHORIZED: 403,
  SIGNER_NOT_OWNER: 403,
  REPO_FROZEN: 423,
  REPO_KILLED: 423,
  MEMORY_REPO_OUTDATED: 502,
} as const

/**
 * How long a write's response waits for its receipt to be stored. A stuck
 * disk must not hold up the answer to a write that has already happened;
 * the append goes on after this and logs its own failure.
 */
const RECEIPT_STORE_WAIT_MS = 1_000

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
  // The recorder signs exactly as the server's identity does, keeping a copy
  // of each signed call for its receipt
  const recorder = recordCalls(signer.identity)
  const agent = await createMemoryRepoAgent(host, recorder.identity)
  const context: ReceiptContext = { agent, canisterId, recorder }
  return {
    actor: createMemoryRepoActor(canisterId, agent),
    signer,
    commitToBranch: (kind, branch, message, diff, tags) =>
      writeWithReceipt(context, { kind, args: [branch, message, diff, tags] }),
    createBranchFrom: (name, base) => writeWithReceipt(context, { kind: 'branch', args: [name, base] }),
  }
}

/**
 * Makes the write, then stores its receipt if one was built, waiting at most
 * RECEIPT_STORE_WAIT_MS for it. A receipt that could not be built or stored
 * is logged and the write's result returned as it is: the write has
 * happened, and the caller must see it as it is. Logs name the kind, branch,
 * request id and result only, never the message, diff or argument, which
 * hold memory content.
 */
async function writeWithReceipt(context: ReceiptContext, call: ReceiptedCall): Promise<OperationResult> {
  const { result, receipt, captureError } = await callWithReceipt(context, call)
  const branch = call.args[0]
  if (receipt) {
    const about = `for ${call.kind} on branch ${branch} (request ${receipt.id}, result ${receipt.result.ok})`
    const settled = (async () => {
      try {
        await appendIcpWriteReceipt(receipt)
      } catch (error) {
        console.error(`memory_repo write receipt not stored ${about}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return true
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), RECEIPT_STORE_WAIT_MS)
    })
    try {
      if (!(await Promise.race([settled, waited]))) {
        console.error(`memory_repo write receipt still being stored ${about} after ${RECEIPT_STORE_WAIT_MS} ms; answering the write without it`)
      }
    } finally {
      clearTimeout(timer)
    }
  } else if (captureError) {
    console.error(`memory_repo write receipt not captured for ${call.kind} on branch ${branch}: ${captureError}`)
  }
  return result
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
