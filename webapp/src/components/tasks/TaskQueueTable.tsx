import { CheckCircle2, Clock, XCircle, RefreshCw } from 'lucide-react'

export interface Task {
  id: string
  type: 'deploy' | 'backup' | 'restore' | 'upgrade'
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  message: string
  createdAt: string
  completedAt?: string
  error?: string
}

interface TaskQueueTableProps {
  tasks: Task[]
  emptyMessage?: string
  isLoading?: boolean
}

function TimeAgo({ timestamp }: { timestamp: string }) {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return <span className="text-xs text-muted-foreground">{diffDays}d ago</span>
  if (diffHours > 0) return <span className="text-xs text-muted-foreground">{diffHours}h ago</span>
  if (diffMins > 0) return <span className="text-xs text-muted-foreground">{diffMins}m ago</span>
  return <span className="text-xs text-muted-foreground">just now</span>
}

export function TaskQueueTable({ tasks, emptyMessage = 'No tasks found', isLoading = false }: TaskQueueTableProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-8 h-8 text-muted-foreground animate-spin" />
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  const getStatusIcon = (status: Task['status']) => {
    switch (status) {
      case 'running':
        return <RefreshCw className="w-5 h-5 text-primary animate-spin" />
      case 'completed':
        return <CheckCircle2 className="w-5 h-5 text-success" />
      case 'failed':
        return <XCircle className="w-5 h-5 text-destructive" />
      case 'pending':
      default:
        return <Clock className="w-5 h-5 text-warning" />
    }
  }

  return (
    <div className="surface divide-y">
      {tasks.map((task) => (
        <div key={task.id} className="p-4 hover:bg-muted/50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {getStatusIcon(task.status)}
              <div className="font-medium capitalize">{task.type}</div>
            </div>
            <TimeAgo timestamp={task.createdAt} />
          </div>
          <div className="text-sm text-muted-foreground mb-2">{task.message}</div>
          <div className="flex items-center gap-4">
            <div className="flex-1 h-1.5 bg-muted rounded-full">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground w-10 text-right">{task.progress}%</span>
          </div>
          {task.error && (
            <div className="mt-2 text-sm text-destructive bg-destructive/10 px-2 py-1 rounded-md">
              {task.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
