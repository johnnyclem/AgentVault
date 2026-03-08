/**
 * Backbone subsystem validators
 *
 * Zod schemas for validating inputs to the memory, knowledge,
 * communication, and consensus subsystems.
 */

import { z } from 'zod';
import {
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_CATEGORIES,
  MESSAGE_TYPES,
  MESSAGE_PRIORITIES,
  PROPOSAL_TYPES,
  QUORUM_TYPES,
  VOTE_VALUES,
} from './constants.js';

// ── Agent Memory ───────────────────────────────────────────────────────────

export const setMemorySchema = z.object({
  key: z
    .string()
    .min(1, 'Key is required')
    .max(255, 'Key must be at most 255 characters')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Key must be alphanumeric with dots, dashes, or underscores'),
  value: z.string().max(65536, 'Value must be at most 64 KB'),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ttlSeconds: z
    .number()
    .int()
    .positive('TTL must be a positive integer')
    .max(31536000, 'TTL must be at most 1 year')
    .optional(),
});

// ── Knowledge Base ─────────────────────────────────────────────────────────

export const createKnowledgeEntrySchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  content: z.string().min(1, 'Content is required').max(1048576, 'Content must be at most 1 MB'),
  category: z.enum(KNOWLEDGE_CATEGORIES),
  status: z.enum(KNOWLEDGE_STATUSES).default('draft'),
  tags: z.array(z.string().max(100)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateKnowledgeEntrySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(1048576).optional(),
  category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Agent Communication ────────────────────────────────────────────────────

export const sendMessageSchema = z
  .object({
    toAgentId: z.string().uuid().optional(),
    channel: z.string().min(1).max(100).optional(),
    parentMessageId: z.string().uuid().optional(),
    messageType: z.enum(MESSAGE_TYPES),
    subject: z.string().max(500).optional(),
    body: z.string().min(1, 'Body is required').max(65536),
    priority: z.enum(MESSAGE_PRIORITIES).default('normal'),
    referenceType: z.string().max(100).optional(),
    referenceId: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => data.toAgentId || data.channel, {
    message: 'Either toAgentId or channel is required',
  });

export const acknowledgeMessageSchema = z.object({
  acknowledgedAt: z.string().datetime().optional(),
});

// ── Consensus ──────────────────────────────────────────────────────────────

export const createProposalSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().min(1, 'Description is required').max(65536),
  proposalType: z.enum(PROPOSAL_TYPES),
  quorumType: z.enum(QUORUM_TYPES).default('majority'),
  knowledgeEntryId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const castVoteSchema = z.object({
  vote: z.enum(VOTE_VALUES),
  reasoning: z.string().max(10000).optional(),
});

// ── Re-export inferred types ───────────────────────────────────────────────

export type SetMemorySchema = z.infer<typeof setMemorySchema>;
export type CreateKnowledgeEntrySchema = z.infer<typeof createKnowledgeEntrySchema>;
export type UpdateKnowledgeEntrySchema = z.infer<typeof updateKnowledgeEntrySchema>;
export type SendMessageSchema = z.infer<typeof sendMessageSchema>;
export type AcknowledgeMessageSchema = z.infer<typeof acknowledgeMessageSchema>;
export type CreateProposalSchema = z.infer<typeof createProposalSchema>;
export type CastVoteSchema = z.infer<typeof castVoteSchema>;
