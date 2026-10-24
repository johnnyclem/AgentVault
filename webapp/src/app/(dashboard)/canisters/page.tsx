'use client'

import type { LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BriefcaseBusiness,
  Cable,
  Command,
  Flame,
  HeartOff,
  Mail,
  PawPrint,
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
}

function crewStateTone(state: ControlCenterCrewMember['state']): string {
  switch (state) {
    case 'Ready':
      return 'bg-success/15 text-success'
    case 'On Patrol':
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

function Panel({ title, count, icon: Icon, children, actionLabel = 'Expand' }: PanelProps) {
  return (
    <section className="surface overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{count}</span>
        </div>
        <button className="chip">
          {actionLabel}
        </button>
      </div>
      <div className="min-h-[150px] p-3">{children}</div>
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

  return (
    <div className="page max-w-7xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">
          {model.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <button className="chip px-3 py-1.5 text-sm">
            <Command className="h-4 w-4" />
            Commands
            <span className="rounded bg-muted px-1.5 text-xs">⌘K</span>
          </button>
          <p className="text-xs text-muted-foreground">
            Auto-refresh: {model.stats.autoRefreshSeconds}s
          </p>
          <p className="text-xs text-muted-foreground">Updated: {refreshedAt ?? '—'}</p>
        </div>
      </div>

      <section className="surface px-4 py-4">
        <div className="flex items-center gap-3 text-lg">
          <span className="text-xl">🎩</span>
          <span className="font-semibold">{model.mayor.name}</span>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
            {model.mayor.status}
          </span>
          {isLoading && (
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">syncing</span>
          )}
          {error && (
            <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs text-destructive">data fallback</span>
          )}
        </div>
      </section>

      <section className="surface flex flex-wrap items-center gap-5 px-4 py-3">
        <div
          className={clsx(
            'flex items-center gap-2 rounded-md px-3 py-2',
            model.stats.heartbeat ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive'
          )}
        >
          <HeartOff className="h-4 w-4" />
          <span className="text-sm">{model.stats.heartbeat ? 'heartbeat nominal' : 'no heartbeat'}</span>
        </div>

        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <span className="text-2xl font-semibold">{model.stats.workers}</span>
            <span className="text-sm text-muted-foreground">Workers</span>
          </div>
          <div className="flex items-center gap-2">
            <Cable className="h-4 w-4 text-muted-foreground" />
            <span className="text-2xl font-semibold">{model.stats.hooks}</span>
            <span className="text-sm text-muted-foreground">Hooks</span>
          </div>
          <div className="flex items-center gap-2">
            <BriefcaseBusiness className="h-4 w-4 text-muted-foreground" />
            <span className="text-2xl font-semibold">{model.stats.work}</span>
            <span className="text-sm text-muted-foreground">Work</span>
          </div>
          <div className="flex items-center gap-2">
            <Truck className="h-4 w-4 text-muted-foreground" />
            <span className="text-2xl font-semibold">{model.stats.convoys}</span>
            <span className="text-sm text-muted-foreground">Convoys</span>
          </div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            <span className="text-2xl font-semibold">{model.stats.escalations}</span>
            <span className="text-sm text-muted-foreground">Escalations</span>
          </div>
        </div>

        <div className="ml-auto">
          <span className="inline-flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1 text-sm font-semibold text-destructive">
            <Flame className="h-4 w-4" />
            {model.stats.p1p2} P1/P2
          </span>
        </div>
      </section>

      {/* Four columns only from 2xl: at 1280 each panel would be ~230px and clip its table. */}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
        <Panel title="Convoys" count={model.convoys.length} icon={Truck}>
          <div className="space-y-2 text-sm">
            {model.convoys.map((convoy) => (
              <div key={convoy.id} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{convoy.id}</span>
                  <span className="text-xs text-muted-foreground">{convoy.eta}</span>
                </div>
                <p className="text-xs text-muted-foreground">{convoy.route}</p>
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
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Rig</th>
                  <th className="pb-2 pr-3">State</th>
                  <th className="pb-2 pr-3">Hook</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.crew.map((member) => (
                  <tr key={member.name}>
                    <td className="py-2 pr-3 font-medium">{member.name}</td>
                    <td className="py-2 pr-3">{member.rig}</td>
                    <td className="py-2 pr-3">
                      <span className={clsx('rounded px-2 py-0.5 text-xs', crewStateTone(member.state))}>
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
              <div key={worker.name} className="flex items-center justify-between surface-muted rounded-lg p-2.5">
                <div>
                  <p className="font-medium">{worker.name}</p>
                  <p className="text-xs text-muted-foreground">{worker.role}</p>
                </div>
                <div className="text-right">
                  <span className={clsx('rounded px-2 py-0.5 text-xs', workerStateTone(worker.status))}>
                    {worker.status}
                  </span>
                  <p className="text-xs text-muted-foreground">{worker.uptime}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Sessions" count={model.sessions.length} icon={ShieldAlert}>
          <div className="space-y-2 text-sm">
            {model.sessions.map((session) => (
              <div key={session.id} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{session.id}</span>
                  <span className="text-xs text-muted-foreground">{session.lastSeen}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {session.owner} · {session.state}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Activity" count={model.activity.length} icon={BriefcaseBusiness}>
          <div className="space-y-2 text-sm">
            {model.activity.map((entry) => (
              <div key={entry.id} className="surface-muted rounded-lg p-2.5">
                <p>{entry.message}</p>
                <p className="text-xs text-muted-foreground">{entry.age}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Mail" count={model.inbox.length} icon={Mail}>
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="rounded-full bg-secondary px-2 py-1 text-foreground">Inbox</span>
            <span className="rounded-full px-2 py-1 text-muted-foreground">All Traffic</span>
          </div>
          <div className="space-y-2 text-sm">
            {model.inbox.map((mail) => (
              <div key={mail.id} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{mail.from}</span>
                  <span className="text-xs text-muted-foreground">{mail.age}</span>
                </div>
                <p className="text-xs text-muted-foreground">{mail.subject}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Merge Queue" count={model.mergeQueue.length} icon={Cable}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-3">PR</th>
                  <th className="pb-2 pr-3">Repo</th>
                  <th className="pb-2 pr-3">Title</th>
                  <th className="pb-2 pr-3">CI</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.mergeQueue.map((item) => (
                  <tr key={item.pr}>
                    <td className="py-2 pr-3 font-medium">{item.pr}</td>
                    <td className="py-2 pr-3">{item.repo}</td>
                    <td className="max-w-[200px] py-2 pr-3 truncate text-muted-foreground">{item.title}</td>
                    <td className="py-2 pr-3">
                      <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', mergeCiTone(item.ci))}>
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
              <div key={item.id} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', escalationTone(item.severity))}>
                    {item.severity}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.owner}</span>
                </div>
                <p className="mt-1 text-xs">{item.title}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Rigs" count={model.rigs.length} icon={Truck}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Polecats</th>
                  <th className="pb-2 pr-3">Crew</th>
                  <th className="pb-2 pr-3">Agents</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {model.rigs.map((rig) => (
                  <tr key={rig.name}>
                    <td className="py-2 pr-3 font-medium">{rig.name}</td>
                    <td className="py-2 pr-3">{rig.polecats}</td>
                    <td className="py-2 pr-3">{rig.crew}</td>
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
              <div key={dog.name} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{dog.name}</span>
                  <span className="text-xs text-muted-foreground">{dog.status}</span>
                </div>
                <p className="text-xs text-muted-foreground">Handler: {dog.handler}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Work" count={model.workItems.length} icon={BriefcaseBusiness} actionLabel="+ New">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="rounded-full bg-secondary px-2 py-1 text-foreground">Ready</span>
            <span className="rounded-full px-2 py-1 text-muted-foreground">In Progress</span>
            <span className="rounded-full px-2 py-1 text-muted-foreground">All</span>
          </div>
          <div className="space-y-2 text-sm">
            {model.workItems.map((item) => (
              <div key={item.id} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', priorityTone(item.priority))}>
                    {item.priority}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.age}</span>
                </div>
                <p className="mt-1 font-medium">{item.id}</p>
                <p className="truncate text-xs text-muted-foreground">{item.title}</p>
                <span className={clsx('mt-1 inline-flex rounded px-2 py-0.5 text-xs font-medium', workStatusTone(item.status))}>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Hooks" count={model.hooks.length} icon={Cable}>
          <div className="space-y-2 text-sm">
            {model.hooks.map((hook) => (
              <div key={hook.name} className="surface-muted rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{hook.name}</span>
                  <span
                    className={clsx(
                      'rounded px-2 py-0.5 text-xs',
                      hook.status === 'Bound' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {hook.status}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{hook.target}</p>
                <p className="text-xs text-muted-foreground">Last run: {hook.lastRun}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}
