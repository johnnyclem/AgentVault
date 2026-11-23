'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import type { Ed25519KeyIdentity } from '@dfinity/identity'
import { createMemoryRepoActor, createMemoryRepoAgent, validateCanisterId } from '@/canister/memory-repo-actor'
import { readCanisterControl, type CanisterControl } from '@/canister/memory-repo-control'
import { Dialog } from '@/components/common/Dialog'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { getICPNetworkConfig } from '@/lib/icp-connection'
import { cn, formatBytes, truncatePrincipal } from '@/lib/utils'
import { OwnerActionError, ownerActionStates, runOwnerAction, type OwnerAction } from '@/lib/owner/actions'
import { OwnerKeyError, parseOwnerKey } from '@/lib/owner/key'
import { formatBurn, formatRunway, formatTrillions, readRunState, runwayDays, type RunState } from '@/lib/owner/status'

/*
 * Manage a memory canister with its owner's key. The key is read in this tab, held in memory, and
 * signs calls that go straight to the Internet Computer: it is never stored, and nothing here
 * calls this server. Locking, or closing the tab, forgets it.
 */

interface Overview {
  owner: string
  frozen: boolean
  killed: boolean
  writers: number
  commits: bigint
  heapBytes: bigint
  control: CanisterControl
}

type Signer = { identity: Ed25519KeyIdentity; principal: string }
type Notice = { kind: 'ok' | 'error'; text: string }

const host = () => getICPNetworkConfig().host

/** The panel's own words: the canister's replies name its methods, and the state above already shows the change. */
const DONE: Record<OwnerAction['kind'], string> = {
  freeze: 'Frozen.',
  unfreeze: 'Unfrozen.',
  addWriter: 'Writer authorized.',
  removeWriter: 'Writer removed.',
}

async function readOverview(canisterId: string): Promise<Overview> {
  const agent = await createMemoryRepoAgent(host())
  const actor = createMemoryRepoActor(canisterId, agent)
  const [security, repo, control] = await Promise.all([
    actor.getSecurityStatus(),
    actor.getRepoStatus(),
    readCanisterControl(agent, canisterId),
  ])
  return {
    owner: security.owner,
    frozen: security.frozenMode,
    killed: security.canisterKilled,
    writers: Number(security.authorizedCount),
    commits: repo.totalCommits,
    heapBytes: security.heapBytes,
    control,
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 break-words tabular-nums">{children}</dd>
    </div>
  )
}

function Principal({ value }: { value: string }) {
  return (
    <span className="tag" title={value}>
      {truncatePrincipal(value)}
    </span>
  )
}

function stateOf(overview: Overview): { label: string; tone: string } {
  if (overview.killed) return { label: 'Killed', tone: 'bg-destructive/10 text-destructive' }
  if (overview.frozen) return { label: 'Frozen', tone: 'bg-warning/15 text-warning' }
  return { label: 'Running', tone: 'bg-success/15 text-success' }
}

/** The owner's key, asked for and read here. What is typed is cleared as soon as it is read. */
function KeyForm({ onKey }: { onKey: (identity: Ed25519KeyIdentity) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const use = (pem: string) => {
    try {
      onKey(parseOwnerKey(pem))
      setText('')
      setError(null)
    } catch (caught) {
      setError(caught instanceof OwnerKeyError ? caught.message : "Couldn't read that key.")
    }
  }

  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        use(text)
      }}
    >
      <input
        type="password"
        name="owner-key"
        aria-label="Owner key"
        placeholder="Paste your owner key"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="h-9 min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm"
      />
      <button type="submit" disabled={text.trim() === ''} className="chip text-foreground">
        <LockOpen className="h-4 w-4" aria-hidden="true" />
        Unlock
      </button>
      <label className="chip cursor-pointer text-foreground">
        Choose file
        <input
          type="file"
          accept=".pem,.txt,text/plain"
          className="sr-only"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) use(await file.text())
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export default function OwnerPage() {
  const [canisterInput, setCanisterInput] = useState('')
  const [canisterId, setCanisterId] = useState<string | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [signer, setSigner] = useState<Signer | null>(null)
  const [run, setRun] = useState<RunState | { error: string } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [writer, setWriter] = useState('')
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  // Reads started before the latest one must not overwrite it.
  const latest = useRef(0)

  const load = useCallback(async (id: string, key: Signer | null) => {
    const mine = ++latest.current
    try {
      const next = await readOverview(id)
      let nextRun: RunState | { error: string } | null = null
      if (key) {
        try {
          nextRun = await readRunState(await createMemoryRepoAgent(host(), key.identity), id)
        } catch {
          nextRun = { error: "This key isn't a controller of the canister, so its cycles aren't shown." }
        }
      }
      if (mine !== latest.current) return
      setOverview(next)
      setRun(nextRun)
      setLoadError(null)
    } catch (caught) {
      if (mine !== latest.current) return
      setOverview(null)
      setLoadError(caught instanceof Error ? caught.message.split('\n')[0] ?? 'Unknown error' : 'Unknown error')
    }
  }, [])

  const open = useCallback(
    (text: string) => {
      const id = text.trim()
      try {
        validateCanisterId(id)
      } catch (caught) {
        setOverview(null)
        setLoadError(caught instanceof Error ? caught.message : 'Invalid canister ID')
        return
      }
      setCanisterId(id)
      setNotice(null)
      void load(id, signer)
    },
    [load, signer],
  )

  // A canister named in the address opens at once.
  useEffect(() => {
    const named = new URLSearchParams(window.location.search).get('canister')
    if (named) {
      setCanisterInput(named)
      open(named)
    }
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Nothing of the key outlives the page.
  useEffect(() => {
    const forget = () => setSigner(null)
    window.addEventListener('pagehide', forget)
    return () => window.removeEventListener('pagehide', forget)
  }, [])

  const unlock = (identity: Ed25519KeyIdentity) => {
    const next = { identity, principal: identity.getPrincipal().toText() }
    setSigner(next)
    setNotice(null)
    if (canisterId) void load(canisterId, next)
  }

  const lock = () => {
    setSigner(null)
    setRun(null)
    setNotice(null)
    setWriter('')
  }

  const act = async (action: OwnerAction) => {
    if (!canisterId || !signer) return
    setBusy(true)
    setNotice(null)
    try {
      const agent = await createMemoryRepoAgent(host(), signer.identity)
      await runOwnerAction(createMemoryRepoActor(canisterId, agent), signer.principal, action)
      setNotice({ kind: 'ok', text: DONE[action.kind] })
      if (action.kind === 'addWriter' || action.kind === 'removeWriter') setWriter('')
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof OwnerActionError ? caught.message : "Couldn't reach the canister." })
    } finally {
      setConfirmRemoval(false)
      // The canister's state is read again either way: what is shown is what it says.
      await load(canisterId, signer)
      setBusy(false)
    }
  }

  const states = overview ? ownerActionStates(overview, signer?.principal ?? null) : null
  const state = overview ? stateOf(overview) : null
  const isOwner = overview && signer ? signer.principal === overview.owner : false

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Owner</h1>
        <p className="page-subtitle">Manage a memory canister with its owner key. The key stays in this tab.</p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          open(canisterInput)
        }}
      >
        <input
          aria-label="Canister ID"
          placeholder="Canister ID"
          autoComplete="off"
          spellCheck={false}
          value={canisterInput}
          onChange={(event) => setCanisterInput(event.target.value)}
          className="h-9 min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm"
        />
        <button type="submit" disabled={canisterInput.trim() === ''} className="chip text-foreground">
          Open
        </button>
      </form>

      {loadError ? <ErrorNotice title="Couldn't read the canister." message={loadError} /> : null}

      {overview && state ? (
        <section className="surface space-y-4 p-6" aria-label="Canister">
          <div className="flex items-center justify-between gap-3">
            <span className={cn('inline-flex h-6 items-center rounded-sm px-2 text-xs font-medium', state.tone)}>{state.label}</span>
            <span className="tag" title={canisterId ?? ''}>{canisterId ? truncatePrincipal(canisterId) : ''}</span>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Owner"><Principal value={overview.owner} /></Fact>
            <Fact label="Writers">{overview.writers}</Fact>
            <Fact label="Commits">{overview.commits.toString()}</Fact>
            <Fact label="Heap">{formatBytes(overview.heapBytes)}</Fact>
            <Fact label="Controllers">
              {overview.control.controllers.length === 0 ? 'None' : (
                <span className="flex flex-wrap gap-1">
                  {overview.control.controllers.map((controller) => <Principal key={controller} value={controller} />)}
                </span>
              )}
            </Fact>
            <Fact label="Code">
              {overview.control.moduleHash ? <span className="tag" title={overview.control.moduleHash}>{overview.control.moduleHash.slice(0, 12)}</span> : 'None'}
            </Fact>
          </dl>
        </section>
      ) : null}

      {overview ? (
        <section className="surface space-y-4 p-6" aria-label="Signing">
          {signer ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-sm">
                Signed in as <Principal value={signer.principal} />
              </p>
              <button type="button" onClick={lock} className="chip text-foreground">
                <Lock className="h-4 w-4" aria-hidden="true" />
                Lock
              </button>
            </div>
          ) : (
            <KeyForm onKey={unlock} />
          )}

          {signer && !isOwner ? (
            <p role="alert" className="text-sm text-warning">This key is not the owner.</p>
          ) : null}

          {signer && run && 'error' in run ? <p className="text-sm text-muted-foreground">{run.error}</p> : null}
          {signer && run && !('error' in run) ? (
            <dl className="grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Cycles">{formatTrillions(run.cycles)}</Fact>
              <Fact label="Lasts">{formatRunway(runwayDays(run.cycles, run.burnPerDay))}</Fact>
              <Fact label="Burn">{formatBurn(run.burnPerDay)}</Fact>
              <Fact label="Memory used">{formatBytes(run.memoryBytes)}</Fact>
            </dl>
          ) : null}
        </section>
      ) : null}

      {overview && signer && isOwner && states ? (
        <section className="surface space-y-5 p-6" aria-label="Changes">
          <div className="space-y-2">
            {overview.frozen ? (
              <button type="button" disabled={busy || !states.unfreeze.allowed} onClick={() => void act({ kind: 'unfreeze' })} className="chip text-foreground">
                Unfreeze
              </button>
            ) : (
              <button type="button" disabled={busy || !states.freeze.allowed} onClick={() => void act({ kind: 'freeze' })} className="chip text-foreground">
                Freeze
              </button>
            )}
            {!states.freeze.allowed && !states.unfreeze.allowed ? (
              <p className="text-sm text-muted-foreground">{states.freeze.reason}</p>
            ) : null}
          </div>

          <div className="space-y-2 border-t pt-4">
            <div className="flex flex-wrap gap-2">
              <input
                aria-label="Writer principal"
                placeholder="Writer principal"
                autoComplete="off"
                spellCheck={false}
                value={writer}
                onChange={(event) => setWriter(event.target.value)}
                className="h-9 min-w-[14rem] flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm"
              />
              <button
                type="button"
                disabled={busy || writer.trim() === '' || !states.addWriter.allowed}
                onClick={() => void act({ kind: 'addWriter', principal: writer })}
                className="chip text-foreground"
              >
                Authorize
              </button>
              <button
                type="button"
                disabled={busy || writer.trim() === '' || !states.removeWriter.allowed}
                onClick={() => setConfirmRemoval(true)}
                className="chip text-destructive"
              >
                Remove
              </button>
            </div>
            {!states.addWriter.allowed ? <p className="text-sm text-muted-foreground">{states.addWriter.reason}</p> : null}
          </div>
        </section>
      ) : null}

      {notice ? (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={cn('text-sm', notice.kind === 'error' ? 'text-destructive' : 'text-success')}>
          {notice.text}
        </p>
      ) : null}

      {confirmRemoval ? (
        <Dialog labelledBy="remove-writer-title" onClose={busy ? undefined : () => setConfirmRemoval(false)} panelClassName="surface w-full max-w-md space-y-4 p-6">
          <h2 id="remove-writer-title" className="text-base font-medium">Remove this writer?</h2>
          <p className="break-all font-mono text-sm">{writer.trim()}</p>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => setConfirmRemoval(false)} className="chip text-foreground">
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => void act({ kind: 'removeWriter', principal: writer })} className="chip text-destructive">
              Remove
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}
