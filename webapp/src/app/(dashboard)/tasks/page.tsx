'use client'

import { useState } from 'react'
import { CheckCircle2, Clock, XCircle, Filter } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { useTasks } from '@/hooks/useTasks'
import { DataTable } from '@/components/common/DataTable'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import type { Column } from '@/components/common/DataTable'
import type { Task } from '@/lib/types'

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
    render: (value, row) => (
      <div className="flex items-center gap-2">
        {row.status === 'running' && <Clock className="w-4 h-4 text-primary" />}
        {row.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-success" />}
        {row.status === 'failed' && <XCircle className="w-4 h-4 text-destructive" />}
        {row.status === 'pending' && <Clock className="w-4 h-4 text-warning" />}
        <StatusBadge status={row.status} />
      </div>
    ),
  },
  {
    key: 'progress',
    label: 'Progress',
    render: (value, row) => (
      <div className="w-full">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${row.progress}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground">{row.progress}%</span>
      </div>
    ),
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
        <h1 className="page-title">Task Queue</h1>
        <p className="page-subtitle">
          Monitor background tasks and operations
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <p className="text-sm text-destructive">{error.message}</p>
        </div>
      ) : (
        <div className="surface">
          <DataTable
            columns={columns}
            data={filteredTasks}
            emptyMessage="No tasks found"
          />
        </div>
      )}
    </div>
  )
}
