import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  buildAgentModel,
  readAgentConfigRecord,
  resolveAgentSourcePath,
  resolveProjectRoot,
} from '@/lib/server/agent-models.js'
import {
  getWallet,
  generateWallet,
  listAgentWallets,
  importWalletFromPrivateKey,
  importWalletFromSeed,
} from '@/wallet/index.js'
import type { WalletData } from '@/wallet/types.js'
import {
  type ArchiveMetadata,
  listArchives,
  prepareArchive,
  getArchivePath,
  updateArchiveTransaction,
  confirmArchive,
  failArchive,
  getArchiveData,
  markArchiveUploading,
} from '@/archival/archive-manager.js'
import { ArweaveClient } from '@/archival/arweave-client.js'
import { exportBackup } from '@/backup/index.js'
import { packageAgent } from '@/packaging/index.js'
import { deployAgent } from '@/deployment/index.js'

const DEFAULT_PROFILE_FILES: Record<ArchiveAssetKind, string[]> = {
  config: [
    'agent.json',
    'agent.yaml',
    'agent.yml',
    'agentvault.json',
    '.agentvault.json',
    'agent.config.json',
    'package.json',
    'goose.yaml',
    'goose.yml',
    'clawdbot.json',
    'clawdbot.config.json',
    'cline.json',
    '.cline.json',
    'cline.config.json',
  ],
  skill: [
    'skill.json',
    'skills.json',
    'skills.yaml',
    'skills.yml',
    'tooling.json',
    'tooling.yaml',
    'tools.json',
    'tools.yaml',
    'tools.yml',
    'goose.yaml',
    'goose.yml',
    'cline.json',
    '.cline.json',
    'clawdbot.json',
  ],
  token: ['token', 'token.json', 'token.yaml', 'token.yml', 'auth.json', 'credentials.json'],
  soul: ['soul', 'soul.json', 'soul.yaml', 'soul.yml', 'identity.json', 'state.json'],
  memory: ['memory', 'memory.json', 'memory.yaml', 'memory.yml', '.agent-memory.json'],
}

const PROFILE_HINTS: Record<ArchiveProfile, Partial<Record<ArchiveAssetKind, string[]>>> = {
  'claude-code': {
    config: ['CLAUDE.md', '.claude/config.json', '.claude/settings.json', 'agent.json', 'agent.yaml', 'agent.yml'],
    skill: ['skills.json', 'claude_skills.json', 'tools.json', 'tools.yaml'],
    token: ['token.json', 'CLAUDE_TOKEN', 'token', '.claude/token.json'],
    soul: ['soul.json', '.claude/soul.json', 'soul', 'state.json'],
    memory: ['memory.json', '.claude/memory.json', 'memory', 'soul', 'state.json'],
  },
  openclaw: {
    config: ['clawdbot.json', '.clawdbot/config.json', 'agent.json', 'agent.yaml'],
    skill: ['skills.json', 'clawdbot.skill.json', 'tools.json'],
    token: ['token.json', 'auth.json', 'credentials.json'],
    soul: ['soul.json', 'context.json', 'identity.json'],
    memory: ['memory.json', '.clawdbot/memory.json', 'state.json'],
  },
  goose: {
    config: ['goose.yaml', 'goose.yml', 'agent.yaml', 'agent.json'],
    skill: ['agent.skills.yaml', 'skills.yaml', 'skills.json', 'goose.yaml'],
    token: ['token.json', '.env', '.env.local', 'credentials.json'],
    soul: ['soul.yaml', 'soul.json', 'state.yaml'],
    memory: ['memory.yaml', 'memory.json', 'state.yaml'],
  },
  opencode: {
    config: ['cline.json', 'cline.config.json', 'agent.json', 'agent.yaml'],
    skill: ['skill.json', 'skills.json', 'tools.json', 'cline.json'],
    token: ['token.json', 'auth.json', 'credentials.json'],
    soul: ['soul.json', 'state.json', 'identity.json'],
    memory: ['memory.json', 'state.json', 'context.json'],
  },
  other: {},
}

type ArchiveProfile =
  | 'claude-code'
  | 'openclaw'
  | 'goose'
  | 'opencode'
  | 'other'

type ArchiveAssetKind = 'config' | 'skill' | 'token' | 'soul' | 'memory'

interface ArchiveAssetPaths {
  config?: string
  skill?: string
  token?: string
  soul?: string
  memory?: string
}

export interface ArchiveDetectInput {
  agentId: string
  profile: string
  sourcePath?: string
  artifactPaths?: ArchiveAssetPaths
}

export interface ArchiveDetectResult {
  agentId: string
  profile: ArchiveProfile
  sourcePath: string | null
  detectedPaths: ArchiveAssetPaths
  requiredPaths: ArchiveAssetPaths
  missing: ArchiveAssetKind[]
  autoDetected: boolean
}

export interface WalletWalletAction {
  method: 'generate' | 'import-seed' | 'import-private-key'
  privateKey?: string
  seedPhrase?: string
  derivationPath?: string
}

export interface WalletSelectionInput {
  icpWalletId?: string
  arweaveWalletId?: string
  arweaveJwk?: string | Record<string, unknown>
}

export interface ArchiveRunInput {
  agentId: string
  profile: string
  sourcePath?: string
  artifactPaths?: ArchiveAssetPaths
  wallets?: WalletSelectionInput
  network?: string
  mode?: 'auto' | 'install' | 'reinstall' | 'upgrade'
  canisterId?: string
  environment?: string
  identity?: string
  cycles?: string
}

export interface ArchiveReceipt {
  archiveId: string
  canisterId: string
  canisterExplorerUrl: string
  backupPath: string
  archiveDataPath: string
  artifactPaths: ArchiveAssetPaths
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

export interface ArchiveWorkflowError {
  code: string
  message: string
  missing?: ArchiveAssetKind[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeProfile(profile: unknown): ArchiveProfile {
  if (!profile || typeof profile !== 'string') {
    return 'other'
  }

  const normalized = profile.trim().toLowerCase().replace(/\s+/g, '-')
  if (normalized === 'claude-code' || normalized === 'claudecode') {
    return 'claude-code'
  }
  if (normalized === 'openclaw') {
    return 'openclaw'
  }
  if (normalized === 'goose') {
    return 'goose'
  }
  if (normalized === 'opencode' || normalized === 'open-code') {
    return 'opencode'
  }

  return 'other'
}

function resolveAgentSource(agentId: string, sourcePath?: string): string | null {
  const configRecord = readAgentConfigRecord(agentId)
  const requestedSourcePath = asString(sourcePath)

  return (
    resolveAgentSourcePath(agentId, configRecord, requestedSourcePath) || null
  )
}

function findByHints(root: string, hints: string[]): string | undefined {
  const normalizedHints = [...new Set(hints)]

  for (const hint of normalizedHints) {
    const candidate = path.resolve(root, hint)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

function findByKeyword(root: string, keyword: string): string | undefined {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const match = entries.find((entry) => entry.name.toLowerCase().includes(keyword))
  return match ? path.resolve(root, match.name) : undefined
}

function detectAssetPaths(root: string, profile: ArchiveProfile, kind: ArchiveAssetKind): string | undefined {
  const profileHints = PROFILE_HINTS[profile][kind] ?? []
  const genericHints = DEFAULT_PROFILE_FILES[kind]
  return (
    findByHints(root, profileHints) ||
    findByHints(root, genericHints) ||
    findByKeyword(root, kind)
  )
}

function coercePaths(sourcePath: string, artifactPaths?: ArchiveAssetPaths): {
  raw: ArchiveAssetPaths
  normalized: ArchiveAssetPaths
  missing: ArchiveAssetKind[]
} {
  const resolved: ArchiveAssetPaths = {}
  const raw: ArchiveAssetPaths = {}
  const missing: ArchiveAssetKind[] = []

  const kinds: ArchiveAssetKind[] = ['config', 'skill', 'token', 'soul', 'memory']

  for (const kind of kinds) {
    const provided = artifactPaths?.[kind]
    if (!provided) {
      continue
    }

    raw[kind] = provided

    const candidate = path.isAbsolute(provided)
      ? provided
      : path.resolve(process.cwd(), provided)

    if (!candidate || !fs.existsSync(candidate)) {
      missing.push(kind)
      continue
    }

    resolved[kind] = candidate
  }

  return { raw, normalized: resolved, missing }
}

export function detectArchiveArtifacts(input: ArchiveDetectInput): ArchiveDetectResult {
  const profile = normalizeProfile(input.profile)
  const normalizedSource = resolveAgentSource(input.agentId, input.sourcePath)

  if (!normalizedSource || !fs.existsSync(normalizedSource)) {
    return {
      agentId: input.agentId,
      profile,
      sourcePath: normalizedSource,
      detectedPaths: {},
      requiredPaths: {},
      missing: ['config', 'skill', 'token', 'soul', 'memory'],
      autoDetected: false,
    }
  }

  const providedPaths = coercePaths(normalizedSource, input.artifactPaths)

  const detected: ArchiveAssetPaths = {
    ...providedPaths.normalized,
  }

  const required: ArchiveAssetPaths = {
    ...providedPaths.normalized,
  }

  for (const kind of ['config', 'skill', 'token', 'soul', 'memory'] as ArchiveAssetKind[]) {
    if (detected[kind]) {
      continue
    }

    const found = detectAssetPaths(normalizedSource, profile, kind)
    if (found) {
      detected[kind] = found
      required[kind] = found
      continue
    }

    if (!providedPaths.missing.includes(kind)) {
      providedPaths.missing.push(kind)
    }
  }

  return {
    agentId: input.agentId,
    profile,
    sourcePath: normalizedSource,
    detectedPaths: detected,
    requiredPaths: required,
    missing: providedPaths.missing,
    autoDetected: true,
  }
}

function pickWallet(agentId: string, chain: 'icp' | 'arweave', walletId?: string): WalletData | null {
  if (!walletId) {
    return null
  }

  const wallets = listWalletsForAgent(agentId)

  if (!wallets.length) {
    return null
  }

  return wallets.find((wallet) => wallet.id === walletId && wallet.chain === chain) || null
}

function listWalletsForAgent(agentId: string): WalletData[] {
  try {
    const ids = listAgentWallets(agentId)
    const wallets = ids
      .map((walletId) => {
        const wallet = getWallet(agentId, walletId)
        if (!wallet) {
          return null
        }
        return wallet
      })
      .filter((wallet): wallet is WalletData => Boolean(wallet))

    return wallets
  } catch (_error) {
    return []
  }
}

function parseJwk(raw?: string | Record<string, unknown>): Record<string, unknown> | null {
  if (!raw) {
    return null
  }

  if (typeof raw !== 'string') {
    return asRecord(raw)
  }

  try {
    const parsed = JSON.parse(raw)
    const record = asRecord(parsed)
    return record
  } catch (_error) {
    return null
  }
}

function formatArweaveUrl(txId: string): string {
  return `https://arweave.net/${txId}`
}

function formatCanisterUrl(canisterId: string): string {
  return `https://dashboard.internetcomputer.org/canister/${canisterId}`
}

function buildReceiptOptions(profile: ArchiveProfile, input: ArchiveDetectResult, deployment: any): ArchiveAssetPaths {
  return {
    config: input.requiredPaths.config,
    skill: input.requiredPaths.skill,
    token: input.requiredPaths.token,
    soul: input.requiredPaths.soul,
    memory: input.requiredPaths.memory,
  }
}

function pickWalletMetadata(wallet: WalletData | null): Record<string, unknown> {
  if (!wallet) {
    return {}
  }

  return {
    id: wallet.id,
    chain: wallet.chain,
    address: wallet.address,
    method: wallet.creationMethod,
    updatedAt: wallet.updatedAt,
  }
}

export async function runArchiveWorkflow(input: ArchiveRunInput): Promise<{
  success: true
  receipt: ArchiveReceipt
} | { success: false; error: ArchiveWorkflowError }> {
  const profile = normalizeProfile(input.profile)
  const agent = buildAgentModel(input.agentId)

  if (!agent) {
    return {
      success: false,
      error: {
        code: 'AGENT_NOT_FOUND',
        message: `Agent '${input.agentId}' not found`,
      },
    }
  }

  const detection = detectArchiveArtifacts(input)
  if (!detection.sourcePath) {
    return {
      success: false,
      error: {
        code: 'SOURCE_PATH_REQUIRED',
        message: 'Unable to locate agent source path. Please provide sourcePath in the request or configure sourcePath in the agent record.',
        missing: ['config', 'skill', 'token', 'soul', 'memory'],
      },
    }
  }

  if (detection.missing.length > 0) {
    return {
      success: false,
      error: {
        code: 'MISSING_ARCHIVE_PATHS',
        message: 'Required archive artifact paths are missing. Provide config, skill, token, soul, and memory locations.',
        missing: detection.missing,
      },
    }
  }

  const walletSelection = input.wallets ?? {}

  const availableWallets = listWalletsForAgent(input.agentId)

  const icpWallet = pickWallet(
    input.agentId,
    'icp',
    walletSelection.icpWalletId
  ) ?? availableWallets.find((wallet) => wallet.chain === 'icp')

  if (!icpWallet) {
    return {
      success: false,
      error: {
        code: 'MISSING_ICP_WALLET',
        message: 'ICP wallet is required for deployment workflow.',
      },
    }
  }

  const arweaveWallet = pickWallet(
    input.agentId,
    'arweave',
    walletSelection.arweaveWalletId
  ) ?? availableWallets.find((wallet) => wallet.chain === 'arweave')

  if (!arweaveWallet) {
    return {
      success: false,
      error: {
        code: 'MISSING_ARWEAVE_WALLET',
        message: 'Arweave wallet is required for archive upload. Add one and retry.',
      },
    }
  }

  const network = asString(input.network) ?? 'local'

  let packageResult
  try {
    packageResult = await packageAgent({
      sourcePath: detection.sourcePath,
    })
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'PACKAGE_FAILED',
        message: error instanceof Error ? error.message : 'Unknown packaging error',
      },
    }
  }

  let deployment
  try {
    deployment = await deployAgent({
      wasmPath: packageResult.wasmPath,
      network,
      canisterId: asString(input.canisterId),
      skipConfirmation: true,
      mode: input.mode,
      environment: asString(input.environment),
      identity: asString(input.identity),
      cycles: asString(input.cycles),
      projectRoot: resolveProjectRoot(detection.sourcePath),
    })
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'DEPLOYMENT_FAILED',
        message: error instanceof Error ? error.message : 'Unknown deployment error',
      },
    }
  }

  const canisterId = deployment.canister.canisterId
  let backup
  try {
    backup = await exportBackup({
      agentName: agent.id,
      includeConfig: true,
      canisterId,
      outputPath: undefined,
      includeCanisterState: true,
    })
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'BACKUP_FAILED',
        message: error instanceof Error ? error.message : 'Unknown backup error',
      },
    }
  }

  const walletTags = {
    'agent-id': agent.id,
    'agent-profile': profile,
    canisterId,
    'deploy-tool': deployment.deployTool ?? 'icp',
    'artifact-count': String(Object.keys(detection.requiredPaths).length),
  }

  const receiptPaths = buildReceiptOptions(profile, detection, deployment)

  const archivePayload = {
    agentId: agent.id,
    agentName: agent.name,
    sourcePath: detection.sourcePath,
    profile,
    canisterId,
    packagePath: packageResult.wasmPath,
    artifactPaths: receiptPaths,
    backup,
    wallets: {
      icp: pickWalletMetadata(icpWallet),
      arweave: pickWalletMetadata(arweaveWallet),
    },
    deployedAt: new Date().toISOString(),
    deployTool: deployment.deployTool,
    warnings: deployment.warnings,
    projectRoot: resolveProjectRoot(detection.sourcePath),
    canister: deployment.canister,
  }

  const archiveVersion = packageResult.config.version ?? agentNameVersion(agent)
  const prepared = prepareArchive(agent.id, archiveVersion, archivePayload, {
    tags: {
      'agent-name': agent.id,
      profile,
      canisterId,
      'agent-profile': profile,
      ...(walletTags as Record<string, string>),
    },
  })

  if (!prepared.success || !prepared.archiveId) {
    return {
      success: false,
      error: {
        code: 'ARCHIVE_PREP_FAILED',
        message: prepared.error ?? 'Failed to stage archive metadata',
      },
    }
  }

  const archiveId = prepared.archiveId
  const archiveData = getArchiveData(archiveId)

  if (!archiveData) {
    return {
      success: false,
      error: {
        code: 'ARCHIVE_DATA_MISSING',
        message: `Created archive '${archiveId}' but archive payload file is missing`,
      },
    }
  }

  const parsedWalletMetadataJwk = asRecord(arweaveWallet.chainMetadata)?.jwk as Record<string, unknown> | undefined
  const parsedJwk = parseJwk(walletSelection.arweaveJwk ?? parsedWalletMetadataJwk)

  const arweaveResult = {
    attempted: true,
    skippedReason: undefined as string | undefined,
    transactionId: undefined as string | undefined,
    explorerUrl: undefined as string | undefined,
    error: undefined as string | undefined,
  }

  if (!parsedJwk) {
    failArchive(archiveId, 'No Arweave JWK provided. Add JWK in wallet metadata or provide arweaveJwk in request.')

    return {
      success: false,
      error: {
        code: 'ARWEAVE_JWK_MISSING',
        message: 'Arweave JWK is required to complete the archive upload.',
      },
    }
  }

  markArchiveUploading(archiveId)

  try {
    const client = new ArweaveClient()
    const uploaded = await client.uploadJSON(archiveData, parsedJwk, {
      tags: {
        ...walletTags,
        'agent-id': agent.id,
      },
    })

    if (!uploaded.success || !uploaded.transactionId) {
      failArchive(archiveId, uploaded.error)
      arweaveResult.error = uploaded.error

      return {
        success: false,
        error: {
          code: 'ARWEAVE_UPLOAD_FAILED',
          message: uploaded.error ?? 'Arweave upload failed',
        },
      }
    }

    updateArchiveTransaction(archiveId, uploaded.transactionId)
    confirmArchive(archiveId)
    arweaveResult.transactionId = uploaded.transactionId
    arweaveResult.explorerUrl = formatArweaveUrl(uploaded.transactionId)
  } catch (error) {
    failArchive(archiveId, error instanceof Error ? error.message : 'Unknown Arweave upload error')
    arweaveResult.error = error instanceof Error ? error.message : 'Unknown Arweave upload error'

    return {
      success: false,
      error: {
        code: 'ARWEAVE_UPLOAD_FAILED',
        message: arweaveResult.error,
      },
    }
  }

  return {
    success: true,
    receipt: {
      archiveId,
      canisterId,
      canisterExplorerUrl: formatCanisterUrl(canisterId),
      backupPath: backup.path ?? '',
      archiveDataPath: getArchivePath(archiveId),
      artifactPaths: receiptPaths,
      sourcePath: detection.sourcePath,
      profile,
      deployedAt: archivePayload.deployedAt,
      arweave: arweaveResult,
    },
  }
}

function agentNameVersion(agent: NonNullable<ReturnType<typeof buildAgentModel>>): string {
  return asString((agent as Record<string, unknown>).version) ?? '1.0.0'
}

export async function createWalletForAgent(
  agentId: string,
  chain: 'icp' | 'arweave',
  method: 'generate' | 'import-seed' | 'import-private-key',
  value?: string,
  derivationPath?: string,
  chainMetadata?: Record<string, unknown>,
): Promise<{
  success: true
  wallet: WalletData
} | { success: false; error: string }> {
  if (!agentId) {
    return {
      success: false,
      error: 'agentId is required',
    }
  }

  try {
    if (method === 'generate') {
      const wallet = generateWallet(agentId, chain)
      if (chainMetadata) {
        wallet.chainMetadata = chainMetadata
      }
      return { success: true, wallet }
    }

    if (method === 'import-seed') {
      if (!value) {
        return {
          success: false,
          error: 'seedPhrase is required for import-seed',
        }
      }

      const wallet = importWalletFromSeed(agentId, chain, value, derivationPath, undefined, chainMetadata)
      return { success: true, wallet }
    }

    if (method === 'import-private-key') {
      if (!value) {
        return {
          success: false,
          error: 'privateKey is required for import-private-key',
        }
      }

      const wallet = importWalletFromPrivateKey(agentId, chain, value, undefined, chainMetadata)
      return { success: true, wallet }
    }

    return { success: false, error: 'Unsupported wallet method' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown wallet error',
    }
  }
}

export function listWalletSummaries(agentId: string): WalletData[] {
  return listWalletsForAgent(agentId)
}

export function listAllArchiveRecords(agentName?: string): ArchiveMetadata[] {
  return agentName ? listArchives(agentName) : listArchives()
}
