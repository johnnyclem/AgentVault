// ── Evidence types ──────────────────────────────────────────────────────────

/*
 * What the server knows about an agent's Arweave uploads, and nothing more.
 * There is deliberately no verified, confirmed or block field: the server
 * never checks whether a transaction was mined or what it holds, so any
 * verdict is worked out in the browser against an Arweave gateway.
 */
export interface ArweaveReceipt {
  archiveId: string
  txId: string
  /** SHA-256, lowercase hex, of the exact bytes the server posted */
  checksum: string
  sizeBytes: number
  /** ISO time the archive was recorded; null when the index holds no usable time */
  recordedAt: string | null
  /** The server's own bookkeeping; 'submitted' means the gateway accepted the upload, not that it was mined */
  recordedStatus: 'submitted' | 'uploading' | 'failed'
}

export interface AgentEvidence {
  agentId: string
  agentName: string
  receipts: ArweaveReceipt[]
  generatedAt: string
}

// ── End Evidence types ──────────────────────────────────────────────────────

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
  cycles: bigint | number
  memory: bigint | number
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
  cycles?: bigint | number
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
  balance: bigint | number
  type: 'local' | 'hardware'
  address?: string
  status?: 'connected' | 'disconnected'
  /** The agent the wallet belongs to, as GET /api/wallets reports it */
  agentId?: string
  /** icp, cketh, solana, polkadot or arweave */
  chain?: string
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
  size: bigint | number
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
  amount: bigint | number
  from?: string
  to?: string
  timestamp: string
  status?: 'pending' | 'confirmed' | 'failed'
}

export interface Archive {
  id: string
  /** The archived agent; absent from servers that predate it */
  agentName?: string
  /**
   * 'submitted': the gateway accepted the upload; nothing on the server checks
   * whether it was mined. 'completed' comes only from servers that predate
   * this label and called an accepted upload done.
   */
  status: 'prepared' | 'uploading' | 'submitted' | 'completed' | 'failed'
  canisterId: string
  timestamp: string
  size: bigint | number
  checksum?: string
  arweaveTxId?: string
  cost?: bigint | number
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

export interface ControlCenterConvoy {
  id: string
  route: string
  cargo: string
  eta: string
  status: 'Queued' | 'En Route' | 'Docking'
}

export interface ControlCenterCrewMember {
  name: string
  rig: string
  state: 'Ready' | 'On Patrol' | 'Repairing' | 'Offline'
  hook: string
  activity: string
  session: 'Yes' | 'No'
}

export interface ControlCenterWorker {
  name: string
  role: string
  status: 'Idle' | 'Running' | 'Paused'
  uptime: string
}

export interface ControlCenterSession {
  id: string
  owner: string
  state: 'Active' | 'Idle'
  lastSeen: string
}

export interface ControlCenterActivity {
  id: string
  message: string
  age: string
}

export interface ControlCenterMail {
  id: string
  from: string
  subject: string
  age: string
}

export interface ControlCenterMergeItem {
  pr: string
  repo: string
  title: string
  ci: 'Pass' | 'Fail' | 'Pending'
}

export interface ControlCenterEscalation {
  id: string
  severity: 'P1' | 'P2' | 'P3'
  title: string
  owner: string
}

export interface ControlCenterRig {
  name: string
  polecats: number
  crew: number
  agents: string
}

export interface ControlCenterDog {
  name: string
  handler: string
  status: 'In Kennel' | 'Deployed'
}

export interface ControlCenterWorkItem {
  priority: 'P1' | 'P2' | 'P3'
  id: string
  title: string
  status: 'READY' | 'IN PROGRESS' | 'BLOCKED'
  age: string
}

export interface ControlCenterHook {
  name: string
  target: string
  status: 'Bound' | 'Muted'
  lastRun: string
}

export interface ControlCenterStats {
  heartbeat: boolean
  workers: number
  hooks: number
  work: number
  convoys: number
  escalations: number
  p1p2: number
  autoRefreshSeconds: number
}

export interface ControlCenterData {
  title: string
  mayor: {
    name: string
    status: 'Detached' | 'Connected'
  }
  stats: ControlCenterStats
  convoys: ControlCenterConvoy[]
  crew: ControlCenterCrewMember[]
  workers: ControlCenterWorker[]
  sessions: ControlCenterSession[]
  activity: ControlCenterActivity[]
  inbox: ControlCenterMail[]
  mergeQueue: ControlCenterMergeItem[]
  escalations: ControlCenterEscalation[]
  rigs: ControlCenterRig[]
  dogs: ControlCenterDog[]
  workItems: ControlCenterWorkItem[]
  hooks: ControlCenterHook[]
  updatedAt: string
}
