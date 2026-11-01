'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  AlertCircle,
  Archive,
  CircleAlert,
  KeyRound,
  Loader2,
  Play,
  Settings,
  StopCircle,
  Upload,
  XCircle,
} from 'lucide-react'
import { Dialog } from '@/components/common/Dialog'
import { Select } from '@/components/common/Select'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useCanisterStatus } from '@/hooks/useCanisterStatus'
import { useDeployments } from '@/hooks/useDeployments'
import { useAgent } from '@/hooks/useAgent'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { apiClient } from '@/lib/api-client'
import { describeArchiveOutcome, evidenceHref } from '@/lib/proof/archive-outcome'
import { cn, formatBytes, formatCycles, formatTimestamp } from '@/lib/utils'

type ArchiveProfile = 'claude-code' | 'openclaw' | 'goose' | 'opencode' | 'other'
type ArtifactKind = 'config' | 'skill' | 'token' | 'soul' | 'memory'
type ArchiveStep = 'profile' | 'artifacts' | 'wallets' | 'review' | 'receipt'
type WalletMethod = 'generate' | 'import-seed' | 'import-private-key'

interface ProfileOption {
  value: ArchiveProfile
  label: string
}

interface ArtifactPaths {
  config: string
  skill: string
  token: string
  soul: string
  memory: string
}

interface DetectionResult {
  agentId: string
  profile: ArchiveProfile
  sourcePath: string | null
  detectedPaths: ArtifactPaths
  requiredPaths: ArtifactPaths
  missing: ArtifactKind[]
  autoDetected: boolean
}

interface WalletSummary {
  id: string
  chain: string
  address: string
  hasJwk?: boolean
}

interface ArchiveWalletPayload {
  icpWalletId?: string
  arweaveWalletId?: string
  arweaveJwk?: string
}

interface ArchiveReceipt {
  archiveId: string
  canisterId: string
  canisterExplorerUrl: string
  backupPath: string
  archiveDataPath: string
  artifactPaths: ArtifactPaths
  sourcePath: string
  profile: ArchiveProfile
  deployedAt: string
  arweave?: {
    attempted: boolean
    transactionId?: string
    explorerUrl?: string
    skippedReason?: string
    error?: string
  }
}

const PROFILE_OPTIONS: ProfileOption[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'goose', label: 'Goose' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'other', label: 'Other' },
]

// The hint names the files that usually hold each artifact; the input's own
// placeholder stays generic so the two never say the same thing.
const ARTIFACT_FIELDS: Array<{ key: ArtifactKind; label: string; hint: string }> = [
  { key: 'config', label: 'Config', hint: 'Usually agent.json, agent.yaml or package.json' },
  { key: 'skill', label: 'Skill', hint: 'Usually skills.json or a tool list' },
  { key: 'token', label: 'Token', hint: 'Usually token.json, credentials or an env file' },
  { key: 'soul', label: 'Soul', hint: 'Usually soul.json or state.json' },
  { key: 'memory', label: 'Memory', hint: 'Usually memory.json or context.json' },
]

// One look for every text field in the archive wizard: 36px high, 10px radius, visible focus ring.
const FIELD =
  'h-9 w-full rounded-lg border bg-background px-3 text-sm placeholder:font-sans placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'

const ARCHIVE_STEPS: Array<{ id: ArchiveStep; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'artifacts', label: 'Files' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'review', label: 'Review' },
  { id: 'receipt', label: 'Receipt' },
]

const emptyArtifactPaths: ArtifactPaths = {
  config: '',
  skill: '',
  token: '',
  soul: '',
  memory: '',
}

const asString = (value: string | undefined): string => value?.trim() ?? ''

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { agent, isLoading: agentLoading, error: agentError, refetch: refetchAgent } = useAgent(id)
  const { data: canister, isLoading: canisterLoading, error: canisterError } = useCanisterStatus(agent?.canisterId || '')
  const { deployments, isLoading: deploymentsLoading, refetch: refetchDeployments } = useDeployments({ agentId: id })
  const [isDeploying, setIsDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [deploySuccess, setDeploySuccess] = useState<string | null>(null)
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false)
  const [archiveStep, setArchiveStep] = useState<ArchiveStep>('profile')
  const [archiveProfile, setArchiveProfile] = useState<ArchiveProfile>('claude-code')
  const [archiveSourcePath, setArchiveSourcePath] = useState('')
  const [detection, setDetection] = useState<DetectionResult | null>(null)
  const [artifactPaths, setArtifactPaths] = useState<ArtifactPaths>(emptyArtifactPaths)
  const [isDetecting, setIsDetecting] = useState(false)
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [isFetchingWallets, setIsFetchingWallets] = useState(false)
  const [icpWallets, setIcpWallets] = useState<WalletSummary[]>([])
  const [arweaveWallets, setArweaveWallets] = useState<WalletSummary[]>([])
  const [selectedIcpWalletId, setSelectedIcpWalletId] = useState('')
  const [selectedArweaveWalletId, setSelectedArweaveWalletId] = useState('')
  const [icpWalletMethod, setIcpWalletMethod] = useState<WalletMethod>('generate')
  const [icpSeedPhrase, setIcpSeedPhrase] = useState('')
  const [icpPrivateKey, setIcpPrivateKey] = useState('')
  const [icpDerivationPath, setIcpDerivationPath] = useState('')
  const [arweaveWalletMethod, setArweaveWalletMethod] = useState<WalletMethod>('generate')
  const [arweaveSeedPhrase, setArweaveSeedPhrase] = useState('')
  const [arweavePrivateKey, setArweavePrivateKey] = useState('')
  const [arweaveDerivationPath, setArweaveDerivationPath] = useState('')
  const [arweaveJwk, setArweaveJwk] = useState('')
  const [isCreatingWallet, setIsCreatingWallet] = useState<'icp' | 'arweave' | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiveReceipt, setArchiveReceipt] = useState<ArchiveReceipt | null>(null)

  // Built explicitly rather than via Object.fromEntries + cast: the entries
  // form produces an index signature that does not overlap ArtifactPaths, and
  // the cast hid the fact that a missing key would have gone unnoticed.
  const trimArtifactValues: ArtifactPaths = {
    config: asString(artifactPaths.config),
    skill: asString(artifactPaths.skill),
    token: asString(artifactPaths.token),
    soul: asString(artifactPaths.soul),
    memory: asString(artifactPaths.memory),
  }

  const selectedIcpWallet = icpWallets.find((wallet) => wallet.id === selectedIcpWalletId)
  const selectedArweaveWallet = arweaveWallets.find((wallet) => wallet.id === selectedArweaveWalletId)
  const arweaveNeedsJwk = selectedArweaveWallet !== undefined && !selectedArweaveWallet.hasJwk

  const requiredKinds = useMemo<ArtifactKind[]>(() => {
    if (!detection || detection.missing.length === 0) {
      return ['config', 'skill', 'token', 'soul', 'memory']
    }
    return detection.missing
  }, [detection])

  const areArtifactsReady = requiredKinds.every((kind) => Boolean(trimArtifactValues[kind]))
  const isSourcePathReady = Boolean(
    asString(archiveSourcePath) || asString(detection?.sourcePath ?? undefined)
  )
  const hasWalletSelection = Boolean(selectedIcpWalletId && selectedArweaveWalletId)
  const isArweaveJwkReady = !arweaveNeedsJwk || Boolean(asString(arweaveJwk))
  const canRunArchive = hasWalletSelection && isArweaveJwkReady
  const canAdvanceArtifacts = areArtifactsReady && isSourcePathReady
  const canAdvanceToWallets = canAdvanceArtifacts
  const canSubmitArchive = canAdvanceArtifacts && canRunArchive

  const openWalletStep = async () => {
    if (!isFetchingWallets && icpWallets.length === 0 && arweaveWallets.length === 0) {
      await loadAgentWallets()
    }
    setArchiveStep('wallets')
  }

  const handleDeploy = async () => {
    if (!agent) return

    setDeployError(null)
    setDeploySuccess(null)
    setIsDeploying(true)
    try {
      const response = await apiClient.post<{
        deployment: { canisterId?: string }
      }>('/deployments', {
        agentId: agent.id,
        canisterId: agent.canisterId,
        mode: agent.canisterId ? 'upgrade' : 'auto',
      })

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to deploy agent')
      }

      setDeploySuccess(
        response.data?.deployment?.canisterId
          ? `Deployment completed: ${response.data.deployment.canisterId}`
          : 'Deployment completed successfully'
      )

      await Promise.all([refetchAgent(), refetchDeployments()])
    } catch (error) {
      setDeployError(error instanceof Error ? error.message : 'Failed to deploy agent')
    } finally {
      setIsDeploying(false)
    }
  }

  const handleStop = async () => {
    setIsDeploying(true)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setIsDeploying(false)
  }

  const resetArchiveFlow = () => {
    setArchiveStep('profile')
    setArchiveProfile('claude-code')
    setArchiveSourcePath('')
    setDetection(null)
    setArtifactPaths(emptyArtifactPaths)
    setDetectionError(null)
    setIsDetecting(false)
    setWalletError(null)
    setArchiveError(null)
    setArchiveReceipt(null)
    setIsCreatingWallet(null)
    setIcpSeedPhrase('')
    setIcpPrivateKey('')
    setIcpDerivationPath('')
    setArweaveSeedPhrase('')
    setArweavePrivateKey('')
    setArweaveDerivationPath('')
    setArweaveJwk('')
    setIcpWalletMethod('generate')
    setArweaveWalletMethod('generate')
  }

  const closeArchiveModal = () => {
    setIsArchiveModalOpen(false)
    resetArchiveFlow()
  }

  const loadAgentWallets = async () => {
    setIsFetchingWallets(true)
    setWalletError(null)

    try {
      const [icpResponse, arweaveResponse] = await Promise.all([
        apiClient.get<WalletSummary[]>(`/agents/${id}/wallets?chain=icp`),
        apiClient.get<WalletSummary[]>(`/agents/${id}/wallets?chain=arweave`),
      ])

      const nextIcpWallets = icpResponse.success && icpResponse.data ? icpResponse.data : []
      const nextArWallets = arweaveResponse.success && arweaveResponse.data ? arweaveResponse.data : []

      setIcpWallets(nextIcpWallets)
      setArweaveWallets(nextArWallets)

      setSelectedIcpWalletId((prev) => (prev ? prev : (nextIcpWallets[0]?.id ?? '')))
      setSelectedArweaveWalletId((prev) => (prev ? prev : (nextArWallets[0]?.id ?? '')))
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Unable to load wallets')
    } finally {
      setIsFetchingWallets(false)
    }
  }

  const updateArtifactPath = (kind: ArtifactKind, value: string) => {
    setArtifactPaths((current) => ({
      ...current,
      [kind]: value,
    }))
  }

  const handleDetect = async () => {
    if (!agent) return

    setIsDetecting(true)
    setDetectionError(null)

    try {
      const search = new URLSearchParams({ profile: archiveProfile })
      if (asString(archiveSourcePath)) {
        search.set('sourcePath', asString(archiveSourcePath))
      }

      const response = await apiClient.get<DetectionResult>(`/agents/${agent.id}/archive?${search.toString()}`)
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Unable to detect archive artifacts')
      }

      setDetection(response.data)
      setArtifactPaths({
        config: response.data.requiredPaths.config || response.data.detectedPaths.config || '',
        skill: response.data.requiredPaths.skill || response.data.detectedPaths.skill || '',
        token: response.data.requiredPaths.token || response.data.detectedPaths.token || '',
        soul: response.data.requiredPaths.soul || response.data.detectedPaths.soul || '',
        memory: response.data.requiredPaths.memory || response.data.detectedPaths.memory || '',
      })
      setArchiveSourcePath(response.data.sourcePath || asString(archiveSourcePath))
      setArchiveStep('artifacts')
      await loadAgentWallets()
    } catch (error) {
      setDetectionError(error instanceof Error ? error.message : 'Auto-detect failed')
      setArchiveStep('artifacts')
      await loadAgentWallets()
    } finally {
      setIsDetecting(false)
    }
  }

  const createWallet = async (chain: 'icp' | 'arweave') => {
    setWalletError(null)
    setIsCreatingWallet(chain)

    try {
      const method = chain === 'icp' ? icpWalletMethod : arweaveWalletMethod
      const seedPhrase = chain === 'icp' ? icpSeedPhrase : arweaveSeedPhrase
      const privateKey = chain === 'icp' ? icpPrivateKey : arweavePrivateKey
      const derivationPath = chain === 'icp' ? icpDerivationPath : arweaveDerivationPath
      const trimmedSeed = asString(seedPhrase)
      const trimmedPrivateKey = asString(privateKey)
      const trimmedPath = asString(derivationPath)

      if (method === 'import-seed' && !trimmedSeed) {
        throw new Error('Seed phrase is required for import-seed')
      }

      if (method === 'import-private-key' && !trimmedPrivateKey) {
        throw new Error('Private key is required for import-private-key')
      }

      const response = await apiClient.post<WalletSummary>(`/agents/${agent?.id}/wallets`, {
        chain,
        method,
        value:
          method === 'import-seed'
            ? trimmedSeed
            : method === 'import-private-key'
              ? trimmedPrivateKey
              : undefined,
        derivationPath: trimmedPath || undefined,
        ...(chain === 'arweave' && asString(arweaveJwk) ? { arweaveJwk } : {}),
      })

      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Failed to create wallet')
      }

      if (chain === 'icp') {
        setIcpWallets((current) => [...current, response.data!])
        setSelectedIcpWalletId(response.data.id)
        setIcpSeedPhrase('')
        setIcpPrivateKey('')
        setIcpDerivationPath('')
      } else {
        setArweaveWallets((current) => [...current, response.data!])
        setSelectedArweaveWalletId(response.data.id)
        setArweaveSeedPhrase('')
        setArweavePrivateKey('')
        setArweaveDerivationPath('')
      }
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Wallet operation failed')
    } finally {
      setIsCreatingWallet(null)
    }
  }

  const runArchive = async () => {
    if (!agent) return

    setArchiveLoading(true)
    setArchiveError(null)

    try {
      const trimmedSourcePath = asString(archiveSourcePath)
      const trimmedArweaveJwk = asString(arweaveJwk)
      const trimmedArtifacts = Object.fromEntries(
        Object.entries(trimArtifactValues).map(([kind, value]) => [kind, value])
      ) as ArtifactPaths

      const wallets: ArchiveWalletPayload = {
        icpWalletId: selectedIcpWalletId,
        arweaveWalletId: selectedArweaveWalletId,
        ...(trimmedArweaveJwk ? { arweaveJwk } : {}),
      }

      const payload = {
        profile: archiveProfile,
        sourcePath: trimmedSourcePath || undefined,
        artifactPaths: trimmedArtifacts,
        wallets,
      }

      const response = await apiClient.post<ArchiveReceipt>(`/agents/${agent.id}/archive`, payload)

      if (!response.success || !response.data) {
        throw new Error(response.error?.message || 'Archive run failed')
      }

      setArchiveReceipt(response.data)
      setArchiveStep('receipt')
      setTimeout(() => refetchAgent(), 200)
      setTimeout(() => refetchDeployments(), 200)
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Archive run failed')
      setArchiveStep('review')
    } finally {
      setArchiveLoading(false)
    }
  }

  const openArchiveModal = () => {
    setIsArchiveModalOpen(true)
    resetArchiveFlow()
  }

  if (agentLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (agentError || !agent) {
    return (
      <div className="page">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            href="/agents"
            aria-label="Back to agents"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <div>
            <h1 className="page-title">Agent not found</h1>
            <p className="page-subtitle">
              {agentError?.message || 'The requested agent could not be found.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const archiveOutcome = archiveReceipt ? describeArchiveOutcome(archiveReceipt.arweave) : null

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <Link
            href="/agents"
            aria-label="Back to agents"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="page-title">{agent.name}</h1>
              <StatusBadge status={agent.status} />
            </div>
            <p className="page-subtitle mt-1">
              ID <span className="tag ml-1" title={agent.id}>{agent.id}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={openArchiveModal}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium border bg-card rounded-lg hover:bg-muted transition-colors"
          >
            <Archive className="h-4 w-4" aria-hidden="true" />
            Archive My Agent
          </button>
          <button
            onClick={handleDeploy}
            disabled={isDeploying}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isDeploying ? <LoadingSpinner size="sm" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            {agent.status === 'active' ? '1-Click Redeploy' : '1-Click Deploy'}
          </button>
          {agent.status === 'active' && (
            <button
              onClick={handleStop}
              disabled={isDeploying}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-destructive/30 text-destructive rounded-lg hover:bg-destructive/10 disabled:opacity-50 transition-colors"
            >
              {isDeploying ? <LoadingSpinner size="sm" /> : <StopCircle className="h-4 w-4" aria-hidden="true" />}
              Stop
            </button>
          )}
          <Link
            href={`/agents/${agent.id}/config`}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium border bg-card rounded-lg hover:bg-muted transition-colors"
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
            Configure
          </Link>
        </div>
      </div>

      {deploySuccess && (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          {deploySuccess}
        </div>
      )}

      {deployError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {deployError}
        </div>
      )}

      {/* min-w-0: a full 63-character principal must shrink inside its column, not widen the grid. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <h2 className="text-base font-medium">Status</h2>
          {canisterLoading ? (
            <LoadingSpinner />
          ) : canisterError ? (
            <p className="text-destructive">Failed to load canister status</p>
          ) : canister ? (
            <div className="surface flex-1 space-y-2 p-4 text-sm">
              <p className="kv">
                <span className="text-muted-foreground">Canister ID</span>
                <span className="tag" title={canister.id}>{canister.id}</span>
              </p>
              <p className="kv">
                <span className="text-muted-foreground">Status</span>
                <StatusBadge status={canister.status} />
              </p>
              <p className="kv">
                <span className="text-muted-foreground">Cycles</span>
                <span className="tabular-nums">{formatCycles(canister.cycles)}</span>
              </p>
              <p className="kv">
                <span className="text-muted-foreground">Memory</span>
                <span className="tabular-nums">{formatBytes(canister.memory)}</span>
              </p>
              <p className="kv">
                <span className="text-muted-foreground">Controller</span>
                <span className="tag" title={canister.controller}>{canister.controller}</span>
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground">Canister not deployed</p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <h2 className="text-base font-medium">Metrics</h2>
          <div className="surface flex-1 space-y-2 p-4 text-sm">
            <p className="kv">
              <span className="text-muted-foreground">Requests</span>
              <span className="tabular-nums">{agent.metrics?.requests.toLocaleString() ?? 'N/A'}</span>
            </p>
            <p className="kv">
              <span className="text-muted-foreground">Errors</span>
              <span className={agent.metrics?.errors ? 'tabular-nums text-destructive' : 'tabular-nums'}>
                {agent.metrics?.errors ?? 'N/A'}
              </span>
            </p>
            <p className="kv">
              <span className="text-muted-foreground">Avg latency</span>
              <span className="tabular-nums">{agent.metrics?.avgLatency ? `${agent.metrics.avgLatency}ms` : 'N/A'}</span>
            </p>
            <p className="kv">
              <span className="text-muted-foreground">Uptime</span>
              <span className="tabular-nums">{agent.metrics?.uptime ? `${agent.metrics.uptime}%` : 'N/A'}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-base font-medium">Configuration</h2>
        <div className="surface p-4 space-y-2 text-sm">
          <p className="kv">
            <span className="text-muted-foreground">Entry point</span>
            <span className="tag" title={agent.config.entry}>{agent.config.entry}</span>
          </p>
          <p className="kv">
            <span className="text-muted-foreground">Memory</span>
            <span className="tabular-nums">{agent.config.memory} MB</span>
          </p>
          <p className="kv">
            <span className="text-muted-foreground">Compute</span>
            <span>{agent.config.compute}</span>
          </p>
          <p className="kv">
            <span className="text-muted-foreground">Created</span>
            <span>{formatTimestamp(agent.createdAt)}</span>
          </p>
          <p className="kv">
            <span className="text-muted-foreground">Updated</span>
            <span>{formatTimestamp(agent.updatedAt)}</span>
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-base font-medium">Recent deployments</h2>
        {deploymentsLoading ? (
          <LoadingSpinner />
        ) : deployments.length === 0 ? (
          <p className="text-muted-foreground">No deployments yet</p>
        ) : (
          <div className="surface divide-y">
            {deployments.slice(0, 5).map((deployment) => (
              <div key={deployment.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
                <div>
                  <StatusBadge status={deployment.status} />
                  <span className="ml-2 whitespace-nowrap text-sm text-muted-foreground">{formatTimestamp(deployment.createdAt)}</span>
                  {deployment.error && (
                    <p className="mt-1 text-xs text-destructive">{deployment.error}</p>
                  )}
                </div>
                {deployment.canisterId && (
                  <span className="tag" title={deployment.canisterId}>{deployment.canisterId}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* !mt-0: as a child of .page the overlay would inherit space-y's 24px
          top margin, leaving an undimmed, clickable strip over the header.
          Escape closes it unless the archive is running. */}
      {isArchiveModalOpen && (
        <Dialog
          labelledBy="archive-title"
          onClose={archiveLoading ? undefined : closeArchiveModal}
          className="!mt-0"
          panelClassName="max-w-3xl"
        >
          <div className="flex items-center justify-between border-b px-5 py-4">
            <h3 id="archive-title" className="text-lg font-medium">Archive My Agent</h3>
            <button
              type="button"
              onClick={closeArchiveModal}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              disabled={archiveLoading}
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="max-h-[85vh] space-y-5 overflow-auto p-5">
            <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Steps">
              {ARCHIVE_STEPS.map(({ id, label }, index) => (
                <li
                  key={id}
                  aria-current={archiveStep === id ? 'step' : undefined}
                  className={cn(
                    'rounded-md px-2 py-1',
                    archiveStep === id ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {index + 1}. {label}
                </li>
              ))}
            </ol>

            {archiveError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {archiveError}
              </div>
            )}

            {detectionError && archiveStep === 'artifacts' && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {detectionError}
              </div>
            )}

            {archiveStep === 'profile' && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Pick your agent type and optional source path. We’ll try to auto-detect all archive artifacts.
                </p>
                <div>
                  <label htmlFor="archive-profile" className="mb-1.5 block text-sm font-medium">Agent profile</label>
                  <Select
                    id="archive-profile"
                    value={archiveProfile}
                    onChange={(e) => setArchiveProfile(e.target.value as ArchiveProfile)}
                  >
                    {PROFILE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="archive-source" className="mb-1.5 block text-sm font-medium">
                    Source path (optional)
                  </label>
                  <input
                    id="archive-source"
                    type="text"
                    value={archiveSourcePath}
                    onChange={(event) => setArchiveSourcePath(event.target.value)}
                    className={cn(FIELD, 'font-mono')}
                    placeholder="Auto-detect from the profile"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Example: /Users/me/projects/my-agent
                  </p>
                </div>
                <button
                  onClick={handleDetect}
                  disabled={isDetecting}
                  className="h-9 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isDetecting ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                      Detecting files
                    </span>
                  ) : (
                    'Detect archives'
                  )}
                </button>

                <button
                  onClick={() => setArchiveStep('artifacts')}
                  className="h-9 w-full rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Continue manually
                </button>
              </div>
            )}

            {archiveStep === 'artifacts' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-medium">Artifact locations</h4>
                  <button
                    onClick={() => setArchiveStep('profile')}
                    className="text-sm text-primary hover:underline"
                  >
                    Back
                  </button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {detection?.autoDetected
                    ? 'We found some paths automatically. Confirm or edit each required path.'
                    : 'Automatic detection was not possible. Enter each required location manually.'}
                </p>
                <input
                  type="text"
                  aria-label="Source path"
                  value={detection?.sourcePath || archiveSourcePath || ''}
                  onChange={(event) => setArchiveSourcePath(event.target.value)}
                  className={cn(FIELD, 'font-mono')}
                  placeholder="Path to your agent project"
                />
                {requiredKinds.map((kind) => {
                  const field = ARTIFACT_FIELDS.find((entry) => entry.key === kind)
                  if (!field) {
                    return null
                  }
                  const value = artifactPaths[kind]
                  return (
                    <div key={kind}>
                      <label htmlFor={`artifact-${kind}`} className="mb-1.5 block text-sm font-medium">
                        {field.label}
                      </label>
                      <input
                        id={`artifact-${kind}`}
                        type="text"
                        value={value}
                        onChange={(event) => updateArtifactPath(kind, event.target.value)}
                        aria-describedby={`artifact-${kind}-hint`}
                        className={cn(FIELD, 'font-mono')}
                        placeholder="Path to the file"
                      />
                      <p id={`artifact-${kind}-hint`} className="mt-1 text-xs text-muted-foreground">{field.hint}</p>
                    </div>
                  )
                })}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setArchiveStep('profile')}
                    className="h-9 rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => {
                      void openWalletStep()
                    }}
                    disabled={!canAdvanceToWallets}
                    className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    Continue to wallets
                  </button>
                </div>
              </div>
            )}

            {archiveStep === 'wallets' && (
              <div className="space-y-5">
                <div className="flex justify-between">
                  <h4 className="font-medium">Connect or select wallets</h4>
                  <button
                    onClick={() => setArchiveStep('artifacts')}
                    className="text-sm text-primary hover:underline"
                  >
                    Back
                  </button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Archive flow requires one ICP wallet and one Arweave wallet. Create a new one if missing.
                </p>

                <div className="rounded-lg border p-4">
                  <h5 className="mb-3 flex items-center gap-2 font-medium">
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                    ICP wallet
                  </h5>
                  {walletError && <div className="mb-3 text-sm text-destructive">{walletError}</div>}

                  {isFetchingWallets ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                      Loading existing wallets…
                    </div>
                  ) : icpWallets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No existing ICP wallets found.</p>
                  ) : (
                    <Select
                      aria-label="ICP wallet"
                      value={selectedIcpWalletId}
                      onChange={(event) => setSelectedIcpWalletId(event.target.value)}
                      wrapperClassName="mb-2"
                    >
                      {icpWallets.map((wallet) => (
                        <option key={wallet.id} value={wallet.id}>
                          {wallet.address.slice(0, 10)}… {wallet.id}
                        </option>
                      ))}
                    </Select>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      aria-label="How to add the ICP wallet"
                      value={icpWalletMethod}
                      onChange={(event) => setIcpWalletMethod(event.target.value as WalletMethod)}
                    >
                      <option value="generate">Generate</option>
                      <option value="import-seed">Import from seed</option>
                      <option value="import-private-key">Import private key</option>
                    </Select>

                    {icpWalletMethod === 'import-seed' && (
                      <input
                        type="text"
                        aria-label="ICP seed phrase"
                        value={icpSeedPhrase}
                        onChange={(event) => setIcpSeedPhrase(event.target.value)}
                        className={cn(FIELD, 'sm:col-span-2')}
                        placeholder="Seed phrase"
                      />
                    )}

                    {icpWalletMethod === 'import-private-key' && (
                      <input
                        type="text"
                        aria-label="ICP private key"
                        value={icpPrivateKey}
                        onChange={(event) => setIcpPrivateKey(event.target.value)}
                        className={cn(FIELD, 'sm:col-span-2')}
                        placeholder="Private key"
                      />
                    )}

                    <input
                      type="text"
                      aria-label="ICP derivation path"
                      value={icpDerivationPath}
                      onChange={(event) => setIcpDerivationPath(event.target.value)}
                      className={cn(FIELD, 'sm:col-span-2')}
                      placeholder="Derivation path (optional)"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void createWallet('icp')}
                    disabled={isCreatingWallet === 'icp'}
                    className="mt-3 h-9 w-full rounded-lg border border-primary/40 px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                  >
                    {isCreatingWallet === 'icp' ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                        Creating…
                      </span>
                    ) : (
                      'Create or import ICP wallet'
                    )}
                  </button>
                </div>

                <div className="rounded-lg border p-4">
                  <h5 className="mb-3 flex items-center gap-2 font-medium">
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                    Arweave wallet
                  </h5>

                  {isFetchingWallets ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                      Loading existing wallets…
                    </div>
                  ) : arweaveWallets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No existing Arweave wallets found.</p>
                  ) : (
                    <Select
                      aria-label="Arweave wallet"
                      value={selectedArweaveWalletId}
                      onChange={(event) => setSelectedArweaveWalletId(event.target.value)}
                      wrapperClassName="mb-2"
                    >
                      {arweaveWallets.map((wallet) => (
                        <option key={wallet.id} value={wallet.id}>
                          {wallet.address.slice(0, 10)}… {wallet.id}
                        </option>
                      ))}
                    </Select>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      aria-label="How to add the Arweave wallet"
                      value={arweaveWalletMethod}
                      onChange={(event) => setArweaveWalletMethod(event.target.value as WalletMethod)}
                    >
                      <option value="generate">Generate</option>
                      <option value="import-seed">Import from seed</option>
                      <option value="import-private-key">Import private key</option>
                    </Select>

                    {arweaveWalletMethod === 'import-seed' && (
                      <input
                        type="text"
                        aria-label="Arweave seed phrase"
                        value={arweaveSeedPhrase}
                        onChange={(event) => setArweaveSeedPhrase(event.target.value)}
                        className={cn(FIELD, 'sm:col-span-2')}
                        placeholder="Seed phrase"
                      />
                    )}

                    {arweaveWalletMethod === 'import-private-key' && (
                      <input
                        type="text"
                        aria-label="Arweave private key"
                        value={arweavePrivateKey}
                        onChange={(event) => setArweavePrivateKey(event.target.value)}
                        className={cn(FIELD, 'sm:col-span-2')}
                        placeholder="Private key"
                      />
                    )}

                    <input
                      type="text"
                      aria-label="Arweave derivation path"
                      value={arweaveDerivationPath}
                      onChange={(event) => setArweaveDerivationPath(event.target.value)}
                      className={cn(FIELD, 'sm:col-span-2')}
                      placeholder="Derivation path (optional)"
                    />

                    <label className="sm:col-span-2">
                      <span className="text-xs text-muted-foreground">
                        Arweave JWK (required if selected wallet does not have one)
                      </span>
                      <textarea
                        value={arweaveJwk}
                        onChange={(event) => setArweaveJwk(event.target.value)}
                        className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        rows={4}
                        placeholder='{ "kty": "RSA", "n": "…", "e": "…" }'
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => void createWallet('arweave')}
                    disabled={isCreatingWallet === 'arweave'}
                    className="mt-3 h-9 w-full rounded-lg border border-primary/40 px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                  >
                    {isCreatingWallet === 'arweave' ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                        Creating…
                      </span>
                    ) : (
                      'Create or import Arweave wallet'
                    )}
                  </button>
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setArchiveStep('artifacts')}
                    className="h-9 rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setArchiveStep('review')}
                    disabled={!canRunArchive}
                    className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    Review and run
                  </button>
                </div>
              </div>
            )}

            {archiveStep === 'review' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">Review archive settings</h4>
                  <button
                    onClick={() => setArchiveStep('wallets')}
                    className="text-sm text-primary hover:underline"
                  >
                    Back
                  </button>
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <p><span className="text-muted-foreground">Profile:</span> {archiveProfile}</p>
                  <p><span className="text-muted-foreground">Source:</span> {archiveSourcePath || detection?.sourcePath || 'Unknown'}</p>
                  {requiredKinds.map((kind) => (
                    <p key={kind} className="truncate">
                      <span className="capitalize text-muted-foreground">{kind}:</span> {trimArtifactValues[kind]}
                    </p>
                  ))}
                  <p><span className="text-muted-foreground">ICP wallet:</span> {selectedIcpWallet?.address || 'Not selected'}</p>
                  <p><span className="text-muted-foreground">Arweave wallet:</span> {selectedArweaveWallet?.address || 'Not selected'}</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Running this publishes a deployment receipt to Arweave, publicly and permanently: the agent&apos;s
                  id and name, its canister id and network, and each artifact&apos;s file name, size and SHA-256. No file
                  contents or local paths are included, and the upload shows the address of the paying Arweave wallet.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={runArchive}
                    disabled={!canSubmitArchive || archiveLoading}
                    className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {archiveLoading ? (
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                        Backing up…
                      </span>
                    ) : (
                      'Run archive'
                    )}
                  </button>
                  <button
                    onClick={() => setArchiveStep('wallets')}
                    className="h-9 rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Back
                  </button>
                </div>
              </div>
            )}

            {archiveStep === 'receipt' && archiveReceipt && archiveOutcome && (
              <div className="space-y-4">
                {/* The run ends when the gateway accepts the upload, before it is mined, so no success icon. */}
                <div className="text-center">
                  {archiveOutcome.submitted ? (
                    <Upload className="mx-auto mb-2 h-8 w-8 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <CircleAlert className="mx-auto mb-2 h-8 w-8 text-warning" aria-hidden="true" />
                  )}
                  <p className="font-medium">{archiveOutcome.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{archiveOutcome.detail}</p>
                </div>
                <div className="grid gap-2 text-sm">
                  <p><span className="text-muted-foreground">Archive ID:</span> {archiveReceipt.archiveId}</p>
                  <p><span className="text-muted-foreground">Canister:</span> {archiveReceipt.canisterId}</p>
                  <p><span className="text-muted-foreground">Deployed:</span> {archiveReceipt.deployedAt}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={archiveReceipt.canisterExplorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="chip"
                    >
                      View canister
                    </a>
                    {archiveReceipt.arweave?.explorerUrl ? (
                      <a
                        href={archiveReceipt.arweave.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="chip"
                      >
                        View Arweave receipt
                      </a>
                    ) : null}
                    {archiveOutcome.submitted ? (
                      <Link href={evidenceHref(agent.id)} className="chip">
                        Check it on the Evidence page
                      </Link>
                    ) : null}
                    <a
                      href={`/archives#${archiveReceipt.archiveId}`}
                      target="_blank"
                      className="chip"
                    >
                      Archive record
                    </a>
                  </div>
                  {archiveReceipt.arweave?.skippedReason ? (
                    <p className="text-xs text-warning">{archiveReceipt.arweave.skippedReason}</p>
                  ) : null}
                </div>
                <button
                  onClick={closeArchiveModal}
                  className="h-9 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  )
}
