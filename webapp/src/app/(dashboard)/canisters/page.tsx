'use client'

import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BriefcaseBusiness,
  Cable,
  Command,
  Flame,
  Heart,
  HeartOff,
  Landmark,
  Mail,
  PawPrint,
  Plus,
  ShieldAlert,
  Truck,
  UserRound,
  Wrench,
} from 'lucide-react'
import clsx from 'clsx'
import { useControlCenter } from '@/hooks/useControlCenter'
import { cloneControlCenterFallback } from '@/lib/control-center-fallback'
import type {
  ControlCenterCrewMember,
  ControlCenterEscalation,
  ControlCenterMergeItem,
  ControlCenterWorkItem,
  ControlCenterWorker,
} from '@/lib/types'

interface PanelProps {
  title: string
  count: number
  icon: LucideIcon
  children: ReactNode
  actionLabel?: string
  actionIcon?: LucideIcon
}

/** Work statuses arrive in capitals ('IN PROGRESS'); the page shows them as words. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function crewStateTone(state: ControlCenterCrewMember['state']): string {
  switch (state) {
    case 'Ready':
      return 'bg-success/15 text-success'
    case 'On patrol':
      return 'bg-primary/10 text-primary'
    case 'Repairing':
      return 'bg-warning/15 text-warning'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function workerStateTone(status: ControlCenterWorker['status']): string {
  switch (status) {
    case 'Running':
      return 'bg-success/15 text-success'
    case 'Idle':
      return 'bg-muted text-muted-foreground'
    default:
      return 'bg-warning/15 text-warning'
  }
}

function mergeCiTone(ci: ControlCenterMergeItem['ci']): string {
  switch (ci) {
    case 'Pass':
      return 'bg-success/15 text-success'
    case 'Fail':
      return 'bg-destructive/10 text-destructive'
    default:
      return 'bg-warning/15 text-warning'
  }
}

function escalationTone(severity: ControlCenterEscalation['severity']): string {
  switch (severity) {
    case 'P1':
      return 'bg-destructive/10 text-destructive'
    case 'P2':
      return 'bg-warning/15 text-warning'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function workStatusTone(status: ControlCenterWorkItem['status']): string {
  switch (status) {
    case 'READY':
      return 'bg-success/15 text-success'
    case 'IN PROGRESS':
      return 'bg-primary/10 text-primary'
    default:
      return 'bg-warning/15 text-warning'
  }
}

function priorityTone(priority: ControlCenterWorkItem['priority']): string {
  switch (priority) {
    case 'P1':
      return 'bg-destructive/10 text-destructive'
    case 'P2':
      return 'bg-warning/15 text-warning'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function Panel({ title, count, icon: Icon, children, actionLabel = 'Expand', actionIcon: ActionIcon }: PanelProps) {
  return (
    <section className="surface overflow-hidden">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        </div>
        {/* Not wired yet: drawn quietly and marked unavailable rather than looking live. aria-disabled (not disabled) keeps it focusable. */}
        <button
          type="button"
          aria-disabled="true"
          aria-label={`${actionLabel} ${title}`}
          title="Not available yet"
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          {ActionIcon && <ActionIcon className="h-4 w-4" aria-hidden="true" />}
          {actionLabel}
        </button>
      </div>
      <div className="min-h-[152px] p-4">{children}</div>
    </section>
  )
}

export default function CanistersPage() {
  const fallback = cloneControlCenterFallback()
  const { data, isLoading, error } = useControlCenter({ refreshSeconds: fallback.stats.autoRefreshSeconds })
  const model = data ?? fallback
  // Formatted after mount: the server renders in its own time zone, so a
  // viewer elsewhere would get a hydration text mismatch on this line.
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)
  useEffect(() => {
    setRefreshedAt(new Date(model.updatedAt).toLocaleTimeString())
  }, [model.updatedAt])

  const tag = 'rounded-sm px-2 py-0.5 text-xs'
  const row = 'surface-muted p-3'
  const th = 'pb-2 pr-3 text-xs font-normal text-muted-foreground'

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">
          {model.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" aria-disabled="true" title="Not available yet" className="chip">
            <Command className="h-4 w-4" aria-hidden="true" />
            Commands
            <kbd className="keycap">⌘K</kbd>
          </button>
          <p className="text-xs tabular-nums text-muted-foreground">
            Auto-refresh {model.stats.autoRefreshSeconds}s
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">Updated {refreshedAt ?? '—'}</p>
        </div>
      </div>

      <section className="surface px-4 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <Landmark className="h-[18px] w-[18px] text-muted-foreground" aria-hidden="true" />
          <span className="text-lg font-medium">{model.mayor.name}</span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span
              className={clsx('h-1.5 w-1.5 rounded-full', model.mayor.status === 'Connected' ? 'bg-success' : 'bg-muted-foreground')}
              aria-hidden="true"
            />
            {model.mayor.status}
          </span>
          {isLoading && <span className="text-xs text-muted-foreground">Syncing</span>}
          {error && <span className="text-xs text-destructive">Data fallback</span>}
        </div>
      </section>

      <section className="surface flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
        <div
          className={clsx(
            'flex items-center gap-2 rounded-lg px-3 py-2',
            model.stats.heartbeat ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive'
          )}
        >
          {model.stats.heartbeat ? (
            <Heart className="h-4 w-4" aria-hidden="true" />
          ) : (
            <HeartOff className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="text-sm">{model.stats.heartbeat ? 'Heartbeat nominal' : 'No heartbeat'}</span>
        </div>

        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          {[
            ['Workers', model.stats.workers],
            ['Hooks', model.stats.hooks],
            ['Work', model.stats.work],
            ['Convoys', model.stats.convoys],
            ['Escalations', model.stats.escalations],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2">
              <dt className="order-last text-sm text-muted-foreground">{label}</dt>
              <dd className="figure">{value}</dd>
            </div>
          ))}
        </dl>

        {/* Right-aligned only when the strip fits on one row; when it wraps, the chip stays at the left like the rest. */}
        <div className="xl:ml-auto">
          <span className="inline-flex h-8 items-center gap-2 rounded-lg bg-destructive/10 px-3 text-sm font-medium text-destructive">
            <Flame className="h-4 w-4" aria-hidden="true" />
            <span className="tabular-nums">{model.stats.p1p2}</span> P1/P2
          </span>
        </div>
      </section>

      {/* One column below 1280, two from there: the sidebar leaves a panel under 250px at two columns on a tablet, which clips its table, and the 1280px page frame keeps three columns under 400px each. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Convoys" count={model.convoys.length} icon={Truck}>
          <div className="space-y-2 text-sm">
            {model.convoys.map((convoy) => (
              <div key={convoy.id} className={row}>
                <div className="flex items-center justify-between gap-3">
                  <span className="tag">{convoy.id}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{convoy.eta}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{convoy.route}</p>
                <p className="text-xs text-muted-foreground">
                  {convoy.cargo} · {convoy.status}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Crew" count={model.crew.length} icon={UserRound}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Rig</th>
                  <th className={th}>State</th>
                  <th className={th}>Hook</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.crew.map((member) => (
                  <tr key={member.name}>
                    <td className="py-2 pr-3 font-medium">{member.name}</td>
                    <td className="py-2 pr-3">{member.rig}</td>
                    <td className="py-2 pr-3">
                      <span className={clsx(tag, crewStateTone(member.state))}>
                        {member.state}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{member.hook}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Workers" count={model.workers.length} icon={Wrench}>
          <div className="space-y-2 text-sm">
            {model.workers.map((worker) => (
              <div key={worker.name} className={clsx('flex items-center justify-between gap-3', row)}>
                <div>
                  <p className="font-medium">{worker.name}</p>
                  <p className="text-xs text-muted-foreground">{worker.role}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={clsx(tag, workerStateTone(worker.status))}>
                    {worker.status}
                  </span>
                  <p className="text-xs tabular-nums text-muted-foreground">{worker.uptime}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Sessions" count={model.sessions.length} icon={ShieldAlert}>
          <div className="space-y-2 text-sm">
            {model.sessions.map((session) => (
              <div key={session.id} className={row}>
                <div className="flex items-center justify-between gap-3">
                  <span className="tag">{session.id}</span>
                  <span className="text-xs text-muted-foreground">{session.lastSeen}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {session.owner} · {session.state}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Activity" count={model.activity.length} icon={BriefcaseBusiness}>
          <div className="space-y-2 text-sm">
            {model.activity.map((entry) => (
              <div key={entry.id} className={row}>
                <p>{entry.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">{entry.age}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Mail" count={model.inbox.length} icon={Mail}>
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="rounded-md bg-secondary px-2 py-1 text-foreground">Inbox</span>
            <span className="rounded-md px-2 py-1 text-muted-foreground">All traffic</span>
          </div>
          <div className="space-y-2 text-sm">
            {model.inbox.map((mail) => (
              <div key={mail.id} className={row}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{mail.from}</span>
                  <span className="text-xs text-muted-foreground">{mail.age}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{mail.subject}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Merge queue" count={model.mergeQueue.length} icon={Cable}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={th}>PR</th>
                  <th className={th}>Repo</th>
                  <th className={th}>Title</th>
                  <th className={th}>CI</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.mergeQueue.map((item) => (
                  <tr key={item.pr}>
                    <td className="py-2 pr-3"><span className="tag">{item.pr}</span></td>
                    <td className="py-2 pr-3">{item.repo}</td>
                    <td className="max-w-[96px] truncate py-2 pr-3 text-muted-foreground sm:max-w-[200px]">{item.title}</td>
                    <td className="py-2 pr-3">
                      <span className={clsx(tag, 'font-medium', mergeCiTone(item.ci))}>
                        {item.ci}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Escalations" count={model.escalations.length} icon={AlertTriangle}>
          <div className="space-y-2 text-sm">
            {model.escalations.map((item) => (
              <div key={item.id} className={row}>
                <div className="flex items-center justify-between gap-3">
                  <span className={clsx(tag, 'font-medium', escalationTone(item.severity))}>
                    {item.severity}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.owner}</span>
                </div>
                <p className="mt-2 text-xs">{item.title}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Rigs" count={model.rigs.length} icon={Truck}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Polecats</th>
                  <th className={th}>Crew</th>
                  <th className={th}>Agents</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.rigs.map((rig) => (
                  <tr key={rig.name}>
                    <td className="py-2 pr-3 font-medium">{rig.name}</td>
                    <td className="py-2 pr-3 tabular-nums">{rig.polecats}</td>
                    <td className="py-2 pr-3 tabular-nums">{rig.crew}</td>
                    <td className="py-2 pr-3">{rig.agents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Dogs" count={model.dogs.length} icon={PawPrint}>
          <div className="space-y-2 text-sm">
            {model.dogs.map((dog) => (
              <div key={dog.name} className={row}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{dog.name}</span>
                  <span className="text-xs text-muted-foreground">{dog.status}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Handler: {dog.handler}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Work" count={model.workItems.length} icon={BriefcaseBusiness} actionLabel="New" actionIcon={Plus}>
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="rounded-md bg-secondary px-2 py-1 text-foreground">Ready</span>
            <span className="rounded-md px-2 py-1 text-muted-foreground">In progress</span>
            <span className="rounded-md px-2 py-1 text-muted-foreground">All</span>
          </div>
          <div className="space-y-2 text-sm">
            {model.workItems.map((item) => (
              <div key={item.id} className={row}>
                <div className="flex items-center justify-between gap-2">
                  <span className={clsx(tag, 'font-medium', priorityTone(item.priority))}>
                    {item.priority}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.age}</span>
                </div>
                <p className="mt-2"><span className="tag">{item.id}</span></p>
                <p className="truncate text-xs text-muted-foreground">{item.title}</p>
                <span className={clsx('mt-2 inline-flex', tag, 'font-medium', workStatusTone(item.status))}>
                  {sentenceCase(item.status)}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Hooks" count={model.hooks.length} icon={Cable}>
          <div className="space-y-2 text-sm">
            {model.hooks.map((hook) => (
              <div key={hook.name} className={row}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{hook.name}</span>
                  <span
                    className={clsx(
                      tag,
                      hook.status === 'Bound' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {hook.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{hook.target}</p>
                <p className="text-xs text-muted-foreground">Last run: {hook.lastRun}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}
