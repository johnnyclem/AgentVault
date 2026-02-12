export interface ApiError {
  message: string
  code?: string
  details?: unknown
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ApiError
}

export interface Canister {
  id: string
  name: string
  status: 'running' | 'stopped' | 'stopping' | 'starting' | 'error'
  cycles: bigint
  memory: bigint
  controller: string
  createdAt: string
  updatedAt: string
}

export interface Agent {
  id: string
  name: string
  status: 'active' | 'inactive' | 'deploying' | 'error'
  canisterId?: string
  config: AgentConfig
  metrics?: AgentMetrics
  createdAt: string
  updatedAt: string
}

export interface AgentConfig {
  entry: string
  memory: number
  compute: string
  cycles?: bigint
  routing?: string[]
}

export interface AgentMetrics {
  requests: number
  errors: number
  avgLatency: number
  uptime: number
}

export interface Wallet {
  id: string
  principal: string
  balance: bigint
  type: 'local' | 'hardware'
  address?: string
  status?: 'connected' | 'disconnected'
  createdAt: string
}

export interface Deployment {
  id: string
  agentId: string
  status: 'pending' | 'deploying' | 'completed' | 'failed'
  canisterId?: string
  createdAt: string
  completedAt?: string
  error?: string
}

export interface Backup {
  id: string
  canisterId: string
  timestamp: string
  size: bigint
  checksum: string
  location: string
}

export interface Network {
  name: string
  status: 'connected' | 'disconnected' | 'degraded'
  url: string
  nodeCount: number
}

export interface LogEntry {
  id: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source: string
  canisterId?: string
}

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

export interface Transaction {
  id: string
  type: 'send' | 'receive'
  amount: bigint
  from?: string
  to?: string
  timestamp: string
  status?: 'pending' | 'confirmed' | 'failed'
}

export interface Archive {
  id: string
  status: 'prepared' | 'uploading' | 'completed' | 'failed'
  canisterId: string
  timestamp: string
  size: bigint
  checksum?: string
  arweaveTxId?: string
  cost?: bigint
}

export interface InferenceQuery {
  subnet: string
  module: string
  input: unknown
  cached?: boolean
  latency?: number
  timestamp?: string
}

export interface ApprovalRequest {
  id: string
  type: 'deploy' | 'upgrade' | 'transfer' | 'config'
  target: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  creator: string
  createdAt: string
  expiresAt: string
  signatures: string[]
  requiredSignatures: number
  description?: string
}

export interface ChartDataPoint {
  label: string
  value: number
  timestamp?: string
}

export interface PageParams {
  page?: number
  limit?: number
  sort?: string
  filter?: Record<string, string>
}
