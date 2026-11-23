import { Principal } from '@dfinity/principal'
import type { _SERVICE } from '../../../../src/canister/memory-repo-actor'
import { explainMemoryRepoWriteError, memoryRepoErrorText } from '../../../../src/canister/memory-repo-actor'

/*
 * What the owner can do to a memory_repo from the panel, and when the canister allows it. The rules
 * mirror canister/memory-repo.mo: every owner call but unfreezing runs through the write guard, so
 * a frozen or killed canister refuses to change its writers too, even for its owner.
 */

export type OwnerAction =
  | { kind: 'freeze' }
  | { kind: 'unfreeze' }
  | { kind: 'addWriter'; principal: string }
  | { kind: 'removeWriter'; principal: string }

export type ActionState = { allowed: true } | { allowed: false; reason: string }

export interface OwnerStatusView {
  owner: string
  frozen: boolean
  killed: boolean
}

export function ownerActionStates(status: OwnerStatusView, signer: string | null): Record<OwnerAction['kind'], ActionState> {
  const refuse = (reason: string): ActionState => ({ allowed: false, reason })
  const all = (reason: string) => ({
    freeze: refuse(reason),
    unfreeze: refuse(reason),
    addWriter: refuse(reason),
    removeWriter: refuse(reason),
  })
  if (signer === null) return all('Load your key to make changes.')
  if (signer !== status.owner) return all('This key is not the owner.')
  if (status.killed) return all('This canister was killed. Reviving it is not in the panel yet.')

  const writers = status.frozen
    ? refuse('Unfreeze first. Nothing can change while frozen, writers included.')
    : ({ allowed: true } as const)
  return {
    freeze: status.frozen ? refuse('Already frozen.') : { allowed: true },
    unfreeze: status.frozen ? { allowed: true } : refuse('Not frozen.'),
    addWriter: writers,
    removeWriter: writers,
  }
}

/** A refusal from the canister, in words that say what to do. */
export class OwnerActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnerActionError'
  }
}

const REFUSALS: Record<string, string> = {
  SIGNER_NOT_OWNER: 'Only the owner can do this, and this key is not the owner.',
  SIGNER_NOT_AUTHORIZED: 'Only the owner can do this, and this key is not the owner.',
  REPO_FROZEN: 'The canister is frozen. Unfreeze it first.',
  REPO_KILLED: 'The canister was killed.',
}

function writerPrincipal(text: string): Principal {
  let principal: Principal
  try {
    principal = Principal.fromText(text.trim())
  } catch {
    throw new OwnerActionError('That is not a valid principal.')
  }
  if (principal.isAnonymous()) throw new OwnerActionError('The anonymous principal cannot be a writer.')
  return principal
}

type OwnerActor = Pick<_SERVICE, 'freeze' | 'manualUnlock' | 'addAuthorizedPrincipal' | 'removeAuthorizedPrincipal'>

/** Makes the change and returns the canister's own confirmation. Throws OwnerActionError for a refusal. */
export async function runOwnerAction(actor: OwnerActor, signer: string, action: OwnerAction): Promise<string> {
  // The principal is checked before anything is signed.
  const principal = action.kind === 'addWriter' || action.kind === 'removeWriter' ? writerPrincipal(action.principal) : null
  try {
    const result = await (action.kind === 'freeze'
      ? actor.freeze()
      : action.kind === 'unfreeze'
        ? actor.manualUnlock()
        : action.kind === 'addWriter'
          ? actor.addAuthorizedPrincipal(principal as Principal)
          : actor.removeAuthorizedPrincipal(principal as Principal))
    if ('err' in result) throw new OwnerActionError(result.err)
    return result.ok
  } catch (error) {
    if (error instanceof OwnerActionError) throw error
    const code = explainMemoryRepoWriteError(error, signer)?.code
    throw new OwnerActionError((code && REFUSALS[code]) || memoryRepoErrorText(error))
  }
}
