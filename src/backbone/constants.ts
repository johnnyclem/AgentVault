/**
 * Backbone subsystem constants
 *
 * Shared enumerations and constant values used across the memory, knowledge,
 * communication, and consensus subsystems.
 */

// ── Knowledge ──────────────────────────────────────────────────────────────

export const KNOWLEDGE_STATUSES = ['draft', 'proposed', 'ratified', 'archived'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_CATEGORIES = [
  'general',
  'architecture',
  'policy',
  'decision',
  'process',
  'reference',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

// ── Communication ──────────────────────────────────────────────────────────

export const MESSAGE_TYPES = [
  'text',
  'request',
  'response',
  'notification',
  'decision',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];

// ── Consensus ──────────────────────────────────────────────────────────────

export const PROPOSAL_TYPES = [
  'strategy',
  'knowledge',
  'policy',
  'action',
  'resource',
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const PROPOSAL_STATUSES = [
  'draft',
  'open',
  'passed',
  'rejected',
  'vetoed',
  'expired',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const QUORUM_TYPES = [
  'majority',
  'supermajority',
  'unanimous',
  'board_approval',
] as const;
export type QuorumType = (typeof QUORUM_TYPES)[number];

export const VOTE_VALUES = ['for', 'against', 'abstain'] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

// ── API Paths ──────────────────────────────────────────────────────────────

export const API = {
  memory: '/api/memory',
  knowledge: '/api/knowledge',
  messages: '/api/messages',
  consensus: '/api/consensus',
  vault: '/api/vault',
} as const;
