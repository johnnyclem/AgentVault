'use client'

import { CheckCircle2, AlertTriangle, Clock, RefreshCw, ArrowLeft } from 'lucide-react'
import { Task as TaskType } from '@/lib/types'

interface TaskDetailProps {
  task: {
    id: string
    type: TaskType
    status: 'pending' | 'running' | 'completed' | 'failed'
    progress: number
    message: string
    createdAt: string
    completedAt?: string
    error?: string
  }
  onRetry?: () => void
  isRetrying?: boolean
}

export function TaskDetail({ task, onRetry, isRetrying }: TaskDetailProps) {
  const getStatusIcon = () => {
    switch (task.status) {
      case 'pending':
        return <Clock className="w-6 h-6 text-yellow-500" />
      case 'running':
        return <RefreshCw className="w-6 h-6 text-blue-500 animate-spin" />
      case 'completed':
        return <CheckCircle2 className="w-6 h-6 text-green-500" />
      case 'failed':
        return <XCircle className="w-6 h-6 text-red-500" />
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <ArrowLeft className="w-6 h-6 text-gray-500 cursor-pointer hover:text-gray-700" />
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{task.type.charAt(0).toUpperCase() + task.type.slice(1)}</h2>
        <p className="text-sm text-gray-600">{task.id}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <h3 className="text-xl font-semibold">Status</h3>
          <div className="flex items-center gap-2">
            <StatusBadge status={task.status} />
            <span className="ml-2">{task.status}</span>
          </div>
        </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Progress</h4>
            <div className="w-full">
              <div className="h-2 bg-gray-200 rounded-full">
                <div className="h-full flex items-center">
                  <div className="w-full bg-blue-500 rounded-full" style={{ width: `${task.progress}%` }}></div>
                </div>
              </div>
              <span className="text-sm text-gray-600">{task.progress}%</span>
            </div>
          </div>

          <h4 className="text-sm font-medium mb-2">Message</h4>
          <p className="text-sm">{task.message}</p>
        </div>

        <div>
          <h3 className="text-xl font-semibold">Timing</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-600">Created:</span>
              <TimeAgo timestamp={task.createdAt} />
            </div>
            {task.completedAt && (
              <div className="flex justify-between">
                <span className="text-gray-600">Completed:</span>
                <TimeAgo timestamp={task.completedAt} />
              </div>
            )}
          </div>
        </div>

        {task.error && (
          <div className="bg-red-50 border border-red-200 p-4 rounded">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-red-500 mt-1" />
              <div>
                <p className="font-medium">Error:</p>
                <p className="text-sm">{task.error}</p>
              </div>
            </div>
            {task.status === 'failed' && onRetry && (
              <button
                onClick={onRetry}
                disabled={isRetrying}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {isRetrying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                {isRetrying ? 'Retrying...' : 'Retry Task'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
