'use client'

import { useState } from 'react'
import { Filter } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { Select } from '@/components/common/Select'
import { TimeAgo } from '@/components/common/TimeAgo'
import { useTasks } from '@/hooks/useTasks'
import { DataTable } from '@/components/common/DataTable'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import type { Column } from '@/components/common/DataTable'
import type { Task } from '@/lib/types'

/** A thin bar for one task's progress; the same on the table and on the phone list. */
function Progress({ task }: { task: Task }) {
  return (
    <div className="w-full min-w-24">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={task.progress}
        aria-label={`${task.type} progress`}
      >
        <div className="h-full bg-primary" style={{ width: `${task.progress}%` }} />
      </div>
      <span className="mt-1 block text-xs tabular-nums text-muted-foreground">{task.progress}%</span>
    </div>
  )
}

const columns: Column<Task>[] = [
  {
    key: 'type',
    label: 'Type',
    render: (value) => (
      <span className="capitalize">{String(value)}</span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    render: (_value, row) => <StatusBadge status={row.status} />,
  },
  {
    key: 'progress',
    label: 'Progress',
    render: (_value, row) => <Progress task={row} />,
  },
  {
    key: 'message',
    label: 'Message',
    render: (value) => (
      <span className="text-sm text-muted-foreground">{String(value)}</span>
    ),
  },
  {
    key: 'createdAt',
    label: 'Started',
    render: (value) => (
      <TimeAgo timestamp={String(value)} />
    ),
  },
]

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const { tasks, isLoading, error } = useTasks({ status: statusFilter })

  const filteredTasks = statusFilter === 'all'
    ? tasks
    : tasks.filter((task) => task.status === statusFilter)

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Task queue</h1>
        <p className="page-subtitle">Deploy, backup, restore and upgrade tasks</p>
      </div>

      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          wrapperClassName="w-44"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <ErrorNotice title="Couldn't load tasks." message={error.message} />
      ) : (
        <>
          {/* Below 1024 each task is a card: with the sidebar, a five-column table is cut at the card edge. */}
          <div className="lg:hidden">
            {filteredTasks.length === 0 ? (
              <div className="surface flex items-center justify-center py-12 text-sm text-muted-foreground">No tasks found</div>
            ) : (
              <ul className="surface divide-y">
                {filteredTasks.map((task) => (
                  <li key={task.id} className="space-y-3 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium capitalize">{task.type}</span>
                      <StatusBadge status={task.status} />
                    </div>
                    <Progress task={task} />
                    <p className="text-sm text-muted-foreground">{task.message}</p>
                    <p className="text-xs text-muted-foreground">
                      Started <TimeAgo timestamp={task.createdAt} className="text-xs" />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="surface hidden lg:block">
            <DataTable
              columns={columns}
              data={filteredTasks}
              emptyMessage="No tasks found"
            />
          </div>
        </>
      )}
    </div>
  )
}
