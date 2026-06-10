/**
 * Backbone subsystem types
 *
 * Core data types for the memory, knowledge, communication, and consensus
 * subsystems that form AgentVault's autonomous org backbone.
 */

import type {
  KnowledgeStatus,
  KnowledgeCategory,
  MessageType,
  MessagePriority,
  ProposalType,
  ProposalStatus,
  QuorumType,
  VoteValue,
} from './constants.js';

// ── Agent Memory ───────────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  id: string;
  companyId: string;
  agentId: string;
  key: string;
  value: string;
  metadata?: Record<string, unknown>;
  vaultRef?: string;
  ttlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetMemoryInput {
  key: string;
  value: string;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
}

// ── Knowledge Base ─────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id: string;
  companyId: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  version: number;
  createdBy: string;
  updatedBy?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeEntryInput {
  title: string;
  content: string;
  category: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateKnowledgeEntryInput {
  title?: string;
  content?: string;
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ── Agent Communication ────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId?: string;
  channel?: string;
  parentMessageId?: string;
  messageType: MessageType;
  subject?: string;
  body: string;
  priority: MessagePriority;
  referenceType?: string;
  referenceId?: string;
  acknowledgedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface SendMessageInput {
  toAgentId?: string;
  channel?: string;
  parentMessageId?: string;
  messageType: MessageType;
  subject?: string;
  body: string;
  priority?: MessagePriority;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}

// ── Consensus ──────────────────────────────────────────────────────────────

export interface ConsensusProposal {
  id: string;
  companyId: string;
  title: string;
  description: string;
  proposalType: ProposalType;
  status: ProposalStatus;
  quorumType: QuorumType;
  createdBy: string;
  knowledgeEntryId?: string;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  expiresAt?: string;
  resolvedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProposalInput {
  title: string;
  description: string;
  proposalType: ProposalType;
  quorumType?: QuorumType;
  knowledgeEntryId?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ConsensusVote {
  id: string;
  proposalId: string;
  voterId: string;
  vote: VoteValue;
  reasoning?: string;
  createdAt: string;
}

export interface CastVoteInput {
  vote: VoteValue;
  reasoning?: string;
}

// ── Wiki ──────────────────────────────────────────────────────────────────

export type WikiStaleness = 'fresh' | 'stale' | 'needs-review';

export interface WikiPage extends KnowledgeEntry {
  slug: string;
  crossRefs: string[];
  sourceRefs: string[];
  lastLintedAt?: string;
  contradictions?: string[];
  staleness: WikiStaleness;
}

export interface CreateWikiPageInput extends CreateKnowledgeEntryInput {
  slug: string;
  crossRefs?: string[];
  sourceRefs?: string[];
}

export interface UpdateWikiPageInput extends UpdateKnowledgeEntryInput {
  slug?: string;
  crossRefs?: string[];
  sourceRefs?: string[];
  staleness?: WikiStaleness;
  contradictions?: string[];
  lastLintedAt?: string;
}

export interface RawSource {
  name: string;
  type: 'file' | 'url' | 'text';
  content: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface WikiSchema {
  name: string;
  description: string;
  categories: string[];
  ingestPrompt?: string;
  queryPrompt?: string;
  lintPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface WikiLintIssue {
  type: 'contradiction' | 'orphan' | 'stale' | 'missing-crossref' | 'dead-source';
  severity: 'info' | 'warning' | 'error';
  pageSlug: string;
  description: string;
  suggestedFix?: string;
  relatedSlugs?: string[];
}

export interface WikiLintReport {
  wikiId: string;
  timestamp: string;
  issues: WikiLintIssue[];
  pagesChecked: number;
  healthScore: number;
}

export interface WikiQueryResult {
  answer: string;
  citations: Array<{ slug: string; title: string; excerpt: string }>;
  confidence: number;
  pagesConsulted: string[];
}

export interface WikiIngestResult {
  sourceArchiveId: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  crossRefsAdded: number;
}

export interface WikiLogEntry {
  timestamp: string;
  operation: 'ingest' | 'query' | 'lint' | 'update' | 'delete';
  summary: string;
  pagesSlugs?: string[];
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

// ── Vault Health ───────────────────────────────────────────────────────────

export interface VaultBackboneHealth {
  configured: boolean;
  healthy: boolean;
  vaultAddress?: string;
  vaultVersion?: string;
  message: string;
}
