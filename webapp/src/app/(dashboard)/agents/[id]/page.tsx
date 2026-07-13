'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  AlertCircle,
  Activity,
  Archive,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  StopCircle,
  XCircle,
} from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useCanisterStatus } from '@/hooks/useCanisterStatus'
import { useDeployments } from '@/hooks/useDeployments'
import { useAgent } from '@/hooks/useAgent'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { apiClient } from '@/lib/api-client'
import { formatBytes, formatCycles, formatTimestamp } from '@/lib/utils'

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

const ARTIFACT_FIELDS: Array<{ key: ArtifactKind; label: string; hint: string }> = [
  { key: 'config', label: 'Config', hint: 'agent.json, agent.yaml, package.json, ...' },
  { key: 'skill', label: 'Skill', hint: 'skills.json, tool list, ...' },
  { key: 'token', label: 'Token', hint: 'token.json, credentials, env file...' },
  { key: 'soul', label: 'Soul', hint: 'soul.json, state.json...' },
  { key: 'memory', label: 'Memory', hint: 'memory.json, context.json...' },
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
  const [archiveDoneMessage, setArchiveDoneMessage] = useState<string | null>(null)

  const trimArtifactValues = Object.fromEntries(
    Object.entries(artifactPaths).map(([key, value]) => [key, asString(value)])
  ) as ArtifactPaths

  const selectedIcpWallet = icpWallets.find((wallet) => wallet.id === selectedIcpWalletId)
  const selectedArweaveWallet = arweaveWallets.find((wallet) => wallet.id === selectedArweaveWalletId)
  const arweaveNeedsJwk = Boolean(selectedArweaveWallet) && !selectedArweaveWallet.hasJwk

  const requiredKinds = useMemo<ArtifactKind[]>(() => {
    if (!detection || detection.missing.length === 0) {
      return ['config', 'skill', 'token', 'soul', 'memory']
    }
    return detection.missing
  }, [detection])

  const areArtifactsReady = requiredKinds.every((kind) => Boolean(trimArtifactValues[kind]))
  const isSourcePathReady = Boolean(asString(archiveSourcePath) || asString(detection?.sourcePath))
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
    setArchiveDoneMessage(null)
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
      setArchiveDoneMessage('Archive + deployment completed successfully')
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
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/agents" className="text-gray-500 hover:text-gray-700">
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Agent Not Found</h1>
            <p className="text-muted-foreground">
              {agentError?.message || 'The requested agent could not be found.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/agents" className="text-gray-500 hover:text-gray-700">
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
            <p className="text-muted-foreground">
              ID: {agent.id}
            </p>
          </div>
          <StatusBadge status={agent.status} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openArchiveModal}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition"
          >
            <Archive className="w-4 h-4" />
            Archive My Agent
          </button>
          <button
            onClick={handleDeploy}
            disabled={isDeploying}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition"
          >
            {isDeploying ? <LoadingSpinner size="sm" /> : <Play className="w-4 h-4" />}
            {agent.status === 'active' ? '1-Click Redeploy' : '1-Click Deploy'}
          </button>
          {agent.status === 'active' && (
            <button
              onClick={handleStop}
              disabled={isDeploying}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition"
            >
              {isDeploying ? <LoadingSpinner size="sm" /> : <StopCircle className="w-4 h-4" />}
              Stop
            </button>
          )}
          <Link
            href={`/agents/${agent.id}/config`}
            className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 transition"
          >
            <Settings className="w-4 h-4" />
            Configure
          </Link>
        </div>
      </div>

      {deploySuccess && (
        <div className="rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {deploySuccess}
        </div>
      )}

      {deployError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {deployError}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Status
          </h2>
          {canisterLoading ? (
            <LoadingSpinner />
          ) : canisterError ? (
            <p className="text-red-500">Failed to load canister status</p>
          ) : canister ? (
            <div className="border rounded-lg p-4 space-y-2">
              <p className="flex justify-between">
                <span className="text-gray-600">Canister ID:</span>
                <span className="font-mono">{canister.id}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Status:</span>
                <StatusBadge status={canister.status} />
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Cycles:</span>
                <span>{formatCycles(canister.cycles)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Memory:</span>
                <span>{formatBytes(canister.memory)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Controller:</span>
                <span className="font-mono">{canister.controller.slice(0, 8)}...</span>
              </p>
            </div>
          ) : (
            <p className="text-gray-500">Canister not deployed</p>
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            Metrics
          </h2>
          <div className="border rounded-lg p-4 space-y-2">
            <p className="flex justify-between">
              <span className="text-gray-600">Requests:</span>
              <span>{agent.metrics?.requests.toLocaleString() ?? 'N/A'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-gray-600">Errors:</span>
              <span className="text-red-500">{agent.metrics?.errors ?? 'N/A'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-gray-600">Avg Latency:</span>
              <span>{agent.metrics?.avgLatency ? `${agent.metrics.avgLatency}ms` : 'N/A'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-gray-600">Uptime:</span>
              <span>{agent.metrics?.uptime ? `${agent.metrics.uptime}%` : 'N/A'}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Configuration</h2>
        <div className="border rounded-lg p-4 space-y-2">
          <p className="flex justify-between">
            <span className="text-gray-600">Entry Point:</span>
            <span className="font-mono">{agent.config.entry}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Memory:</span>
            <span>{agent.config.memory} MB</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Compute:</span>
            <span>{agent.config.compute}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Created:</span>
            <span>{formatTimestamp(agent.createdAt)}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Updated:</span>
            <span>{formatTimestamp(agent.updatedAt)}</span>
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Recent Deployments</h2>
        {deploymentsLoading ? (
          <LoadingSpinner />
        ) : deployments.length === 0 ? (
          <p className="text-gray-500">No deployments yet</p>
        ) : (
          <div className="border rounded-lg divide-y">
            {deployments.slice(0, 5).map((deployment) => (
              <div key={deployment.id} className="p-4 flex items-center justify-between">
                <div>
                  <StatusBadge status={deployment.status} />
                  <span className="ml-2 text-sm text-gray-600">{formatTimestamp(deployment.createdAt)}</span>
                  {deployment.error && (
                    <p className="mt-1 text-xs text-red-500">{deployment.error}</p>
                  )}
                </div>
                {deployment.canisterId && (
                  <span className="font-mono text-sm">{deployment.canisterId.slice(0, 8)}...</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {isArchiveModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white rounded-lg shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h3 className="text-lg font-semibold">Archive My Agent</h3>
              <button
                onClick={closeArchiveModal}
                className="text-gray-500 hover:text-gray-700"
                disabled={archiveLoading}
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="max-h-[85vh] overflow-auto p-5 space-y-5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`rounded-full px-2 py-1 ${archiveStep === 'profile' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>
                  1. Profile
                </span>
                <span className={`rounded-full px-2 py-1 ${archiveStep === 'artifacts' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>
                  2. Files
                </span>
                <span className={`rounded-full px-2 py-1 ${archiveStep === 'wallets' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>
                  3. Wallets
                </span>
                <span className={`rounded-full px-2 py-1 ${archiveStep === 'review' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>
                  4. Review
                </span>
                <span className={`rounded-full px-2 py-1 ${archiveStep === 'receipt' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>
                  5. Receipt
                </span>
              </div>

              {archiveError && (
                <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 flex items-start gap-2">
                  <CircleAlert className="w-4 h-4 mt-0.5" />
                  {archiveError}
                </div>
              )}

              {detectionError && archiveStep === 'artifacts' && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5" />
                  {detectionError}
                </div>
              )}

              {archiveStep === 'profile' && (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600">
                    Pick your agent type and optional source path. We’ll try to auto-detect all archive artifacts.
                  </p>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Agent Profile</label>
                    <select
                      value={archiveProfile}
                      onChange={(e) => setArchiveProfile(e.target.value as ArchiveProfile)}
                      className="w-full border px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {PROFILE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Source Path (optional)
                    </label>
                    <input
                      type="text"
                      value={archiveSourcePath}
                      onChange={(event) => setArchiveSourcePath(event.target.value)}
                      className="w-full border px-3 py-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Leave blank to auto-detect from agent profile"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Example: /Users/me/projects/my-agent
                    </p>
                  </div>
                  <button
                    onClick={handleDetect}
                    disabled={isDetecting}
                    className="w-full bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700 transition disabled:opacity-50"
                  >
                    {isDetecting ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Detecting Files
                      </span>
                    ) : (
                      'Detect Archives'
                    )}
                  </button>

                  <button
                    onClick={() => setArchiveStep('artifacts')}
                    className="w-full rounded border px-4 py-2 text-gray-700 hover:bg-gray-100 transition"
                  >
                    Continue Manually
                  </button>
                </div>
              )}

              {archiveStep === 'artifacts' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-medium">Artifact Locations</h4>
                    <button
                      onClick={() => setArchiveStep('profile')}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Back
                    </button>
                  </div>
                  <p className="text-sm text-gray-600">
                    {detection?.autoDetected
                      ? 'We found some paths automatically. Confirm or edit each required path.'
                      : 'Automatic detection was not possible. Enter each required location manually.'}
                  </p>
                  <input
                    type="text"
                    value={detection?.sourcePath || archiveSourcePath || ''}
                    onChange={(event) => setArchiveSourcePath(event.target.value)}
                    className="w-full border px-3 py-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Source path to your agent project"
                  />
                  {requiredKinds.map((kind) => {
                    const field = ARTIFACT_FIELDS.find((entry) => entry.key === kind)
                    if (!field) {
                      return null
                    }
                    const value = artifactPaths[kind]
                    return (
                      <div key={kind}>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {field.label}
                        </label>
                        <input
                          type="text"
                          value={value}
                          onChange={(event) => updateArtifactPath(kind, event.target.value)}
                          className="w-full border px-3 py-2 rounded font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder={field.hint}
                        />
                        <p className="text-xs text-gray-500 mt-1">{field.hint}</p>
                      </div>
                    )
                  })}
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setArchiveStep('profile')}
                      className="px-4 py-2 text-sm text-gray-700 border rounded hover:bg-gray-100 transition"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => {
                        void openWalletStep()
                      }}
                      disabled={!canAdvanceToWallets}
                      className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-700 transition"
                    >
                      Continue to Wallets
                    </button>
                  </div>
                </div>
              )}

              {archiveStep === 'wallets' && (
                <div className="space-y-5">
                  <div className="flex justify-between">
                    <h4 className="font-medium">Connect / Select Wallets</h4>
                    <button
                      onClick={() => setArchiveStep('artifacts')}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Back
                    </button>
                  </div>
                  <p className="text-sm text-gray-600">
                    Archive flow requires one ICP wallet and one Arweave wallet. Create a new one if missing.
                  </p>

                  <div className="border rounded-lg p-4">
                    <div className="flex items-start gap-2 mb-3">
                      <h5 className="font-semibold flex items-center gap-2">
                        <KeyRound className="w-4 h-4" />
                        ICP Wallet
                      </h5>
                    </div>
                    {walletError && <div className="text-sm text-rose-700">{walletError}</div>}

                    {isFetchingWallets ? (
                      <div className="text-sm text-gray-500 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading existing wallets...
                      </div>
                    ) : icpWallets.length === 0 ? (
                      <p className="text-sm text-gray-500">No existing ICP wallets found.</p>
                    ) : (
                      <select
                        value={selectedIcpWalletId}
                        onChange={(event) => setSelectedIcpWalletId(event.target.value)}
                        className="mb-2 w-full border px-3 py-2 rounded"
                      >
                        {icpWallets.map((wallet) => (
                          <option key={wallet.id} value={wallet.id}>
                            {wallet.address.slice(0, 10)}... {wallet.id}
                          </option>
                        ))}
                      </select>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <select
                        value={icpWalletMethod}
                        onChange={(event) => setIcpWalletMethod(event.target.value as WalletMethod)}
                        className="border px-3 py-2 rounded"
                      >
                        <option value="generate">Generate</option>
                        <option value="import-seed">Import from seed</option>
                        <option value="import-private-key">Import private key</option>
                      </select>

                      {icpWalletMethod === 'import-seed' && (
                        <input
                          type="text"
                          value={icpSeedPhrase}
                          onChange={(event) => setIcpSeedPhrase(event.target.value)}
                          className="sm:col-span-2 border px-3 py-2 rounded"
                          placeholder="Seed phrase"
                        />
                      )}

                      {icpWalletMethod === 'import-private-key' && (
                        <input
                          type="text"
                          value={icpPrivateKey}
                          onChange={(event) => setIcpPrivateKey(event.target.value)}
                          className="sm:col-span-2 border px-3 py-2 rounded"
                          placeholder="Private key"
                        />
                      )}

                      <input
                        type="text"
                        value={icpDerivationPath}
                        onChange={(event) => setIcpDerivationPath(event.target.value)}
                        className="sm:col-span-2 border px-3 py-2 rounded"
                        placeholder="Derivation path (optional)"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void createWallet('icp')}
                      disabled={isCreatingWallet === 'icp'}
                      className="mt-3 w-full border border-blue-600 text-blue-600 rounded px-4 py-2 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {isCreatingWallet === 'icp' ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating...
                        </span>
                      ) : (
                        'Create / Import ICP Wallet'
                      )}
                    </button>
                  </div>

                  <div className="border rounded-lg p-4">
                    <h5 className="font-semibold flex items-center gap-2 mb-3">
                      <KeyRound className="w-4 h-4" />
                      Arweave Wallet
                    </h5>

                    {isFetchingWallets ? (
                      <div className="text-sm text-gray-500 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading existing wallets...
                      </div>
                    ) : arweaveWallets.length === 0 ? (
                      <p className="text-sm text-gray-500">No existing Arweave wallets found.</p>
                    ) : (
                      <select
                        value={selectedArweaveWalletId}
                        onChange={(event) => setSelectedArweaveWalletId(event.target.value)}
                        className="mb-2 w-full border px-3 py-2 rounded"
                      >
                        {arweaveWallets.map((wallet) => (
                          <option key={wallet.id} value={wallet.id}>
                            {wallet.address.slice(0, 10)}... {wallet.id}
                          </option>
                        ))}
                      </select>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <select
                        value={arweaveWalletMethod}
                        onChange={(event) => setArweaveWalletMethod(event.target.value as WalletMethod)}
                        className="border px-3 py-2 rounded"
                      >
                        <option value="generate">Generate</option>
                        <option value="import-seed">Import from seed</option>
                        <option value="import-private-key">Import private key</option>
                      </select>

                      {arweaveWalletMethod === 'import-seed' && (
                        <input
                          type="text"
                          value={arweaveSeedPhrase}
                          onChange={(event) => setArweaveSeedPhrase(event.target.value)}
                          className="sm:col-span-2 border px-3 py-2 rounded"
                          placeholder="Seed phrase"
                        />
                      )}

                      {arweaveWalletMethod === 'import-private-key' && (
                        <input
                          type="text"
                          value={arweavePrivateKey}
                          onChange={(event) => setArweavePrivateKey(event.target.value)}
                          className="sm:col-span-2 border px-3 py-2 rounded"
                          placeholder="Private key"
                        />
                      )}

                      <input
                        type="text"
                        value={arweaveDerivationPath}
                        onChange={(event) => setArweaveDerivationPath(event.target.value)}
                        className="sm:col-span-2 border px-3 py-2 rounded"
                        placeholder="Derivation path (optional)"
                      />

                      <label className="sm:col-span-2">
                        <span className="text-xs text-gray-500">
                          Arweave JWK (required if selected wallet does not have one)
                        </span>
                        <textarea
                          value={arweaveJwk}
                          onChange={(event) => setArweaveJwk(event.target.value)}
                          className="mt-1 w-full border rounded px-3 py-2 font-mono text-sm"
                          rows={4}
                          placeholder='{ "kty":"RSA", "n":"...", "e":"..." }'
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => void createWallet('arweave')}
                      disabled={isCreatingWallet === 'arweave'}
                      className="mt-3 w-full border border-blue-600 text-blue-600 rounded px-4 py-2 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {isCreatingWallet === 'arweave' ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating...
                        </span>
                      ) : (
                        'Create / Import Arweave Wallet'
                      )}
                    </button>
                  </div>

                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setArchiveStep('artifacts')}
                      className="px-4 py-2 text-sm text-gray-700 border rounded hover:bg-gray-100 transition"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => setArchiveStep('review')}
                      disabled={!canRunArchive}
                      className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-700 transition"
                    >
                      Review and Run
                    </button>
                  </div>
                </div>
              )}

              {archiveStep === 'review' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Review Archive Settings</h4>
                    <button
                      onClick={() => setArchiveStep('wallets')}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Back
                    </button>
                  </div>
                  <div className="grid gap-3 text-sm text-gray-600 sm:grid-cols-2">
                    <p><span className="text-gray-500">Profile:</span> {archiveProfile}</p>
                    <p><span className="text-gray-500">Source:</span> {archiveSourcePath || detection?.sourcePath || 'Unknown'}</p>
                    {requiredKinds.map((kind) => (
                      <p key={kind} className="truncate">
                        <span className="text-gray-500 capitalize">{kind}:</span> {trimArtifactValues[kind]}
                      </p>
                    ))}
                    <p><span className="text-gray-500">ICP Wallet:</span> {selectedIcpWallet?.address || 'Not selected'}</p>
                    <p><span className="text-gray-500">Arweave Wallet:</span> {selectedArweaveWallet?.address || 'Not selected'}</p>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={runArchive}
                      disabled={!canSubmitArchive || archiveLoading}
                      className="px-4 py-2 rounded bg-green-600 text-white disabled:opacity-50 hover:bg-green-700 transition"
                    >
                      {archiveLoading ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Backing up...
                        </span>
                      ) : (
                        'Run Archive'
                      )}
                    </button>
                    <button
                      onClick={() => setArchiveStep('wallets')}
                      className="px-4 py-2 rounded border text-gray-700 hover:bg-gray-100"
                    >
                      Back
                    </button>
                  </div>
                </div>
              )}

              {archiveStep === 'receipt' && archiveReceipt && (
                <div className="space-y-4">
                  <div className="text-center">
                    <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto mb-2" />
                    <p className="font-semibold">Archive Completed</p>
                    {archiveDoneMessage && <p className="text-sm text-gray-600 mt-1">{archiveDoneMessage}</p>}
                  </div>
                  <div className="grid gap-2 text-sm">
                    <p><span className="text-gray-500">Archive ID:</span> {archiveReceipt.archiveId}</p>
                    <p><span className="text-gray-500">Canister:</span> {archiveReceipt.canisterId}</p>
                    <p><span className="text-gray-500">Deployed:</span> {archiveReceipt.deployedAt}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={archiveReceipt.canisterExplorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded bg-blue-50 text-blue-700 px-3 py-1.5 text-xs"
                      >
                        View Canister
                      </a>
                      {archiveReceipt.arweave?.explorerUrl ? (
                        <a
                          href={archiveReceipt.arweave.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded bg-purple-50 text-purple-700 px-3 py-1.5 text-xs"
                        >
                          View Arweave Receipt
                        </a>
                      ) : null}
                      <a
                        href={`/archives?id=${archiveReceipt.archiveId}`}
                        target="_blank"
                        className="rounded bg-zinc-100 text-zinc-700 px-3 py-1.5 text-xs"
                      >
                        Archive Record
                      </a>
                    </div>
                    {archiveReceipt.arweave?.skippedReason ? (
                      <p className="text-xs text-amber-600">{archiveReceipt.arweave.skippedReason}</p>
                    ) : null}
                  </div>
                  <button
                    onClick={closeArchiveModal}
                    className="w-full rounded bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 transition"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
