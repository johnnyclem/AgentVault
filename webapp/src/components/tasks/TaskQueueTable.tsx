import { CheckCircle2, Clock, XCircle, AlertCircle } from 'lucide-react'
import { formatTimestamp } from '@/lib/utils'

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

export function TaskQueueTable({ tasks, emptyMessage = 'No tasks found', isLoading = false }: TaskQueueTableProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-gray-200 border-t-transparent">
        </div>
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-gray-500">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="border rounded-lg divide-y">
      {tasks.map((task) => (
        <div key={task.id} className="p-4 hover:bg-gray-50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {task.status === 'running' && <Clock className="w-5 h-5 text-blue-500" />}
              {task.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
              {task.status === 'failed' && <XCircle className="w-5 h-5 text-red-500" />}
              <task.status === 'pending' && <Clock className="w-5 h-5 text-yellow-500" />}
            </div>
            <div className="flex items-center gap-4">
              <div className="font-medium capitalize">{task.type}</div>
              <div className="text-sm text-gray-600">{task.message}</div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-32 h-2 bg-gray-200 rounded">
                <div className="h-full flex items-center">
                  <div className="w-32 h-2 bg-blue-500 rounded-full" style={{ width: `${task.progress}%` }}></div>
                <span className="text-xs text-gray-600">{task.progress}%</span>
              </div>
              <TimeAgo timestamp={task.createdAt} />
            </div>
            <TimeAgo timestamp={task.createdAt} />
          </div>
          {task.error && (
            <div className="mt-2 text-sm text-red-600">
              {task.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
