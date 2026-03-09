/**
 * AgentVault Backbone
 *
 * The backbone subsystem provides the memory, knowledge, communication,
 * and consensus infrastructure for autonomous agent organizations.
 *
 * Usage:
 *   import { MemoryService, KnowledgeService } from 'agentvault/backbone';
 */

// Constants & enums
export * from './constants.js';

// Types
export * from './types.js';

// Validators
export {
  setMemorySchema,
  createKnowledgeEntrySchema,
  updateKnowledgeEntrySchema,
  sendMessageSchema,
  acknowledgeMessageSchema,
  createProposalSchema,
  castVoteSchema,
} from './validators.js';
export type {
  SetMemorySchema,
  CreateKnowledgeEntrySchema,
  UpdateKnowledgeEntrySchema,
  SendMessageSchema,
  AcknowledgeMessageSchema,
  CreateProposalSchema,
  CastVoteSchema,
} from './validators.js';

// Services
export * from './services/index.js';
